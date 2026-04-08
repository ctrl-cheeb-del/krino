import { describe, it, expect, vi } from "vitest";
import { Filesystem } from "../filesystem.js";
import { NotFoundError, ConflictError, DirectoryNotEmptyError } from "../errors.js";
import { createMockClient, mockBody, s3Error } from "./helpers.js";

function setup(
  handlers: Record<string, (input: any) => any> = {},
  opts: { prefix?: string; cwd?: string } = {},
) {
  const client = createMockClient(handlers);
  const fs = new Filesystem({
    bucket: "test-bucket",
    client: client as any,
    prefix: opts.prefix,
    cwd: opts.cwd,
  });
  return { fs, client };
}

// ─── constructor ───────────────────────────────────────────

describe("constructor", () => {
  it("defaults cwd to /", () => {
    const { fs } = setup();
    expect(fs.cwd).toBe("/");
  });

  it("uses provided cwd", () => {
    const { fs } = setup({}, { cwd: "/workspace" });
    expect(fs.cwd).toBe("/workspace");
  });

  it("accepts a pre-built S3Client", async () => {
    const client = createMockClient({
      GetObjectCommand: () => ({
        Body: mockBody("ok"),
        ETag: '"e"',
        ContentLength: 2,
        LastModified: new Date(),
      }),
    });
    const fs = new Filesystem({ bucket: "b", client: client as any });
    // Should use the provided client without error
    await expect(fs.readFile("/f")).resolves.toBeDefined();
  });

  it("normalizes prefix by stripping trailing slashes", async () => {
    const { fs, client } = setup(
      {
        GetObjectCommand: () => ({
          Body: mockBody("x"),
          ETag: '"e"',
          ContentLength: 1,
          LastModified: new Date(),
        }),
      },
      { prefix: "pfx///" },
    );
    await fs.readFile("/f.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("pfx/f.txt");
  });

  it("handles empty prefix", async () => {
    const { fs, client } = setup(
      {
        GetObjectCommand: () => ({
          Body: mockBody("x"),
          ETag: '"e"',
          ContentLength: 1,
          LastModified: new Date(),
        }),
      },
      { prefix: "" },
    );
    await fs.readFile("/f.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("f.txt");
  });

  it("handles undefined prefix", async () => {
    const { fs, client } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"e"',
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });
    await fs.readFile("/f.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("f.txt");
  });
});

// ─── readFile ──────────────────────────────────────────────

describe("readFile", () => {
  it("returns content, etag, size, and lastModified", async () => {
    const date = new Date("2025-01-01");
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("hello world"),
        ETag: '"abc123"',
        ContentLength: 11,
        LastModified: date,
      }),
    });

    const result = await fs.readFile("/file.txt");
    expect(result.content).toBe("hello world");
    expect(result.etag).toBe("abc123");
    expect(result.size).toBe(11);
    expect(result.lastModified).toEqual(date);
  });

  it("strips quotes from ETag", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"quoted-etag"',
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.etag).toBe("quoted-etag");
    expect(result.etag).not.toContain('"');
  });

  it("handles unquoted ETag from S3", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: "no-quotes",
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.etag).toBe("no-quotes");
  });

  it("handles missing ETag gracefully", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.etag).toBe("");
  });

  it("handles missing ContentLength", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"e"',
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.size).toBe(0);
  });

  it("handles missing LastModified", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"e"',
        ContentLength: 1,
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.lastModified).toEqual(new Date(0));
  });

  it("handles null/undefined Body", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: undefined,
        ETag: '"e"',
        ContentLength: 0,
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/f");
    expect(result.content).toBe("");
  });

  it("reads empty file content", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody(""),
        ETag: '"e"',
        ContentLength: 0,
        LastModified: new Date(),
      }),
    });
    const result = await fs.readFile("/empty.txt");
    expect(result.content).toBe("");
  });

  it("throws NotFoundError on NoSuchKey", async () => {
    const { fs } = setup({
      GetObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    await expect(fs.readFile("/missing.txt")).rejects.toThrow(NotFoundError);
  });

  it("rethrows non-NoSuchKey errors", async () => {
    const { fs } = setup({
      GetObjectCommand: () => { throw s3Error("InternalError"); },
    });
    await expect(fs.readFile("/f")).rejects.toThrow("InternalError");
    // Should NOT be a NotFoundError
    try {
      await fs.readFile("/f");
    } catch (e: any) {
      expect(e).not.toBeInstanceOf(NotFoundError);
    }
  });

  it("blocks reads of .keep sentinel files", async () => {
    const { fs } = setup({});
    await expect(fs.readFile("/mydir/.keep")).rejects.toThrow(NotFoundError);
    await expect(fs.readFile("/.keep")).rejects.toThrow(NotFoundError);
  });

  it("blocks .keep reads even with prefix", async () => {
    const { fs } = setup({}, { prefix: "pfx" });
    await expect(fs.readFile("/dir/.keep")).rejects.toThrow(NotFoundError);
  });

  it("allows files that contain .keep as substring", async () => {
    const { fs } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("ok"),
        ETag: '"e"',
        ContentLength: 2,
        LastModified: new Date(),
      }),
    });
    // ".keeper" is not ".keep"
    const result = await fs.readFile("/.keeper");
    expect(result.content).toBe("ok");
  });

  it("resolves paths with prefix", async () => {
    const { fs, client } = setup(
      {
        GetObjectCommand: () => ({
          Body: mockBody("x"),
          ETag: '"e"',
          ContentLength: 1,
          LastModified: new Date(),
        }),
      },
      { prefix: "agents/bob" },
    );
    await fs.readFile("/notes.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("agents/bob/notes.txt");
    expect(client.send.mock.calls[0][0].input.Bucket).toBe("test-bucket");
  });

  it("resolves relative paths against cwd", async () => {
    const { fs, client } = setup(
      {
        GetObjectCommand: () => ({
          Body: mockBody("x"),
          ETag: '"e"',
          ContentLength: 1,
          LastModified: new Date(),
        }),
      },
      { cwd: "/workspace" },
    );
    await fs.readFile("todo.md");
    expect(client.send.mock.calls[0][0].input.Key).toBe("workspace/todo.md");
  });

  it("resolves paths with both prefix and cwd", async () => {
    const { fs, client } = setup(
      {
        GetObjectCommand: () => ({
          Body: mockBody("x"),
          ETag: '"e"',
          ContentLength: 1,
          LastModified: new Date(),
        }),
      },
      { prefix: "pfx", cwd: "/workspace" },
    );
    await fs.readFile("file.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("pfx/workspace/file.txt");
  });

  it("NotFoundError display path strips prefix", async () => {
    const { fs } = setup(
      { GetObjectCommand: () => { throw s3Error("NoSuchKey"); } },
      { prefix: "agents/bob" },
    );
    try {
      await fs.readFile("/secret.txt");
    } catch (e: any) {
      // Error message should show user-facing path, not S3 key
      expect(e.message).toContain("/secret.txt");
      expect(e.message).not.toContain("agents/bob");
    }
  });
});

// ─── writeFile ─────────────────────────────────────────────

describe("writeFile", () => {
  it("writes content and returns etag", async () => {
    const { fs } = setup({
      PutObjectCommand: () => ({ ETag: '"new-etag"' }),
    });
    const result = await fs.writeFile("/file.txt", "content");
    expect(result.etag).toBe("new-etag");
  });

  it("sends correct body and default content type", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    await fs.writeFile("/f.txt", "hello");
    const input = client.send.mock.calls[0][0].input;
    expect(input.Body).toBe("hello");
    expect(input.ContentType).toBe("text/plain; charset=utf-8");
  });

  it("writes to correct bucket and key", async () => {
    const { fs, client } = setup(
      { PutObjectCommand: () => ({ ETag: '"e"' }) },
      { prefix: "pfx" },
    );
    await fs.writeFile("/a/b.txt", "x");
    const input = client.send.mock.calls[0][0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("pfx/a/b.txt");
  });

  it("writes empty content", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    await fs.writeFile("/empty.txt", "");
    expect(client.send.mock.calls[0][0].input.Body).toBe("");
  });

  it("does not send IfMatch when no options given", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    await fs.writeFile("/f.txt", "data");
    expect(client.send.mock.calls[0][0].input.IfMatch).toBeUndefined();
  });

  it("sends IfMatch with quotes for conditional writes", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"v2"' }),
    });
    await fs.writeFile("/f.txt", "new", { ifMatch: "old-etag" });
    expect(client.send.mock.calls[0][0].input.IfMatch).toBe('"old-etag"');
  });

  it("preserves already-quoted etags in ifMatch", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"v2"' }),
    });
    await fs.writeFile("/f.txt", "new", { ifMatch: '"already-quoted"' });
    expect(client.send.mock.calls[0][0].input.IfMatch).toBe('"already-quoted"');
  });

  it("uses custom contentType", async () => {
    const { fs, client } = setup({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    await fs.writeFile("/f.json", "{}", { contentType: "application/json" });
    expect(client.send.mock.calls[0][0].input.ContentType).toBe("application/json");
  });

  it("throws ConflictError on PreconditionFailed", async () => {
    const { fs } = setup({
      PutObjectCommand: () => { throw s3Error("PreconditionFailed"); },
    });
    await expect(
      fs.writeFile("/f.txt", "data", { ifMatch: "stale" }),
    ).rejects.toThrow(ConflictError);
  });

  it("ConflictError display path strips prefix", async () => {
    const { fs } = setup(
      { PutObjectCommand: () => { throw s3Error("PreconditionFailed"); } },
      { prefix: "pfx" },
    );
    try {
      await fs.writeFile("/f.txt", "x", { ifMatch: "e" });
    } catch (e: any) {
      expect(e.message).toContain("/f.txt");
      expect(e.message).not.toContain("pfx");
    }
  });

  it("rethrows non-PreconditionFailed errors", async () => {
    const { fs } = setup({
      PutObjectCommand: () => { throw s3Error("ServiceUnavailable"); },
    });
    await expect(fs.writeFile("/f", "x")).rejects.toThrow("ServiceUnavailable");
    try {
      await fs.writeFile("/f", "x");
    } catch (e: any) {
      expect(e).not.toBeInstanceOf(ConflictError);
    }
  });

  it("handles missing ETag in response", async () => {
    const { fs } = setup({
      PutObjectCommand: () => ({}),
    });
    const result = await fs.writeFile("/f", "x");
    expect(result.etag).toBe("");
  });
});

// ─── deleteFile ────────────────────────────────────────────

describe("deleteFile", () => {
  it("sends DeleteObjectCommand with correct bucket and key", async () => {
    const { fs, client } = setup(
      { DeleteObjectCommand: () => ({}) },
      { prefix: "pfx" },
    );
    await fs.deleteFile("/old.txt");
    const input = client.send.mock.calls[0][0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("pfx/old.txt");
  });

  it("is idempotent (no error on missing key)", async () => {
    const { fs } = setup({ DeleteObjectCommand: () => ({}) });
    // S3 DeleteObject returns 204 even if key doesn't exist
    await expect(fs.deleteFile("/nonexistent")).resolves.toBeUndefined();
  });

  it("resolves relative paths", async () => {
    const { fs, client } = setup(
      { DeleteObjectCommand: () => ({}) },
      { cwd: "/workspace" },
    );
    await fs.deleteFile("old.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("workspace/old.txt");
  });
});

// ─── exists ────────────────────────────────────────────────

describe("exists", () => {
  it("returns true when file exists (first HeadObject succeeds)", async () => {
    const { fs, client } = setup({
      HeadObjectCommand: () => ({}),
    });
    expect(await fs.exists("/file.txt")).toBe(true);
    // Should only call HeadObject once (no need to check .keep)
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("returns true when directory sentinel exists", async () => {
    let callCount = 0;
    const { fs } = setup({
      HeadObjectCommand: () => {
        callCount++;
        if (callCount === 1) throw s3Error("NotFound");
        return {};
      },
    });
    expect(await fs.exists("/mydir")).toBe(true);
  });

  it("checks .keep path correctly", async () => {
    let keys: string[] = [];
    const { fs } = setup({
      HeadObjectCommand: (input: any) => {
        keys.push(input.Key);
        throw s3Error("NotFound");
      },
    });
    await fs.exists("/mydir");
    expect(keys[0]).toBe("mydir");
    expect(keys[1]).toBe("mydir/.keep");
  });

  it("returns false when neither file nor directory exists", async () => {
    const { fs } = setup({
      HeadObjectCommand: () => { throw s3Error("NotFound"); },
    });
    expect(await fs.exists("/nope")).toBe(false);
  });

  it("resolves paths with prefix", async () => {
    const { fs, client } = setup(
      { HeadObjectCommand: () => ({}) },
      { prefix: "pfx" },
    );
    await fs.exists("/file.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("pfx/file.txt");
    expect(client.send.mock.calls[0][0].input.Bucket).toBe("test-bucket");
  });
});

// ─── listDir ───────────────────────────────────────────────

describe("listDir", () => {
  it("returns files and directories", async () => {
    const date = new Date("2025-06-01");
    const { fs } = setup({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: "docs/readme.md", Size: 100, LastModified: date },
        ],
        CommonPrefixes: [{ Prefix: "docs/images/" }],
        IsTruncated: false,
      }),
    });
    const entries = await fs.listDir("/docs");
    expect(entries).toEqual([
      { name: "readme.md", type: "file", size: 100, lastModified: date },
      { name: "images", type: "directory" },
    ]);
  });

  it("filters out .keep sentinels from file listings", async () => {
    const { fs } = setup({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: "dir/.keep", Size: 0 },
          { Key: "dir/real.txt", Size: 10 },
        ],
        IsTruncated: false,
      }),
    });
    const entries = await fs.listDir("/dir");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("real.txt");
  });

  it("handles undefined Contents and CommonPrefixes (SDK v3 behavior)", async () => {
    const { fs } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    expect(await fs.listDir("/empty")).toEqual([]);
  });

  it("sends correct Prefix with trailing slash", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    await fs.listDir("/docs");
    expect(client.send.mock.calls[0][0].input.Prefix).toBe("docs/");
  });

  it("sends correct Delimiter", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    await fs.listDir("/docs");
    expect(client.send.mock.calls[0][0].input.Delimiter).toBe("/");
  });

  it("sends correct Bucket", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    await fs.listDir("/");
    expect(client.send.mock.calls[0][0].input.Bucket).toBe("test-bucket");
  });

  it("lists cwd when no path given", async () => {
    const { fs, client } = setup(
      { ListObjectsV2Command: () => ({ IsTruncated: false }) },
      { cwd: "/workspace" },
    );
    await fs.listDir();
    expect(client.send.mock.calls[0][0].input.Prefix).toBe("workspace/");
  });

  it("lists root with prefix", async () => {
    const { fs, client } = setup(
      { ListObjectsV2Command: () => ({ IsTruncated: false }) },
      { prefix: "pfx" },
    );
    await fs.listDir("/");
    expect(client.send.mock.calls[0][0].input.Prefix).toBe("pfx/");
  });

  it("defaults maxItems to 1000", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    await fs.listDir("/d");
    expect(client.send.mock.calls[0][0].input.MaxKeys).toBe(1000);
  });

  it("respects custom maxItems", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    await fs.listDir("/d", { maxItems: 50 });
    expect(client.send.mock.calls[0][0].input.MaxKeys).toBe(50);
  });

  it("paginates using ContinuationToken", async () => {
    let page = 0;
    const { fs, client } = setup({
      ListObjectsV2Command: (input: any) => {
        page++;
        if (page === 1) {
          expect(input.ContinuationToken).toBeUndefined();
          return {
            Contents: [{ Key: "d/a.txt", Size: 1 }],
            IsTruncated: true,
            NextContinuationToken: "page2token",
          };
        }
        expect(input.ContinuationToken).toBe("page2token");
        return {
          Contents: [{ Key: "d/b.txt", Size: 2 }],
          IsTruncated: false,
        };
      },
    });
    const entries = await fs.listDir("/d", { maxItems: 10 });
    expect(entries).toHaveLength(2);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("stops pagination when maxItems is reached", async () => {
    const { fs, client } = setup({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: "d/a.txt", Size: 1 },
          { Key: "d/b.txt", Size: 2 },
        ],
        IsTruncated: true,
        NextContinuationToken: "more",
      }),
    });
    const entries = await fs.listDir("/d", { maxItems: 2 });
    expect(entries).toHaveLength(2);
    // Should not fetch page 2 since we already have 2 items
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("filters empty names from Contents", async () => {
    const { fs } = setup({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "dir/", Size: 0 }], // empty name after prefix strip
        IsTruncated: false,
      }),
    });
    const entries = await fs.listDir("/dir");
    expect(entries).toEqual([]);
  });

  it("strips trailing slash from directory names in CommonPrefixes", async () => {
    const { fs } = setup({
      ListObjectsV2Command: () => ({
        CommonPrefixes: [{ Prefix: "dir/sub/" }],
        IsTruncated: false,
      }),
    });
    const entries = await fs.listDir("/dir");
    expect(entries[0].name).toBe("sub");
    expect(entries[0].name).not.toContain("/");
  });
});

// ─── mkdir ─────────────────────────────────────────────────

describe("mkdir", () => {
  it("writes a .keep sentinel at path/.keep", async () => {
    const { fs, client } = setup({ PutObjectCommand: () => ({}) });
    await fs.mkdir("/newdir");
    const input = client.send.mock.calls[0][0].input;
    expect(input.Key).toBe("newdir/.keep");
    expect(input.Body).toBe("");
    expect(input.ContentType).toBe("application/x-empty");
  });

  it("uses correct bucket", async () => {
    const { fs, client } = setup({ PutObjectCommand: () => ({}) });
    await fs.mkdir("/d");
    expect(client.send.mock.calls[0][0].input.Bucket).toBe("test-bucket");
  });

  it("resolves path with prefix", async () => {
    const { fs, client } = setup(
      { PutObjectCommand: () => ({}) },
      { prefix: "pfx" },
    );
    await fs.mkdir("/sub");
    expect(client.send.mock.calls[0][0].input.Key).toBe("pfx/sub/.keep");
  });

  it("is idempotent (creating existing dir overwrites sentinel)", async () => {
    const { fs } = setup({ PutObjectCommand: () => ({}) });
    await fs.mkdir("/existing");
    await fs.mkdir("/existing");
    // No error thrown
  });

  it("creates nested directory path", async () => {
    const { fs, client } = setup({ PutObjectCommand: () => ({}) });
    await fs.mkdir("/a/b/c");
    expect(client.send.mock.calls[0][0].input.Key).toBe("a/b/c/.keep");
  });
});

// ─── rmdir ─────────────────────────────────────────────────

describe("rmdir", () => {
  describe("non-recursive", () => {
    it("removes empty directory (only .keep sentinel)", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({
          Contents: [{ Key: "mydir/.keep" }],
          IsTruncated: false,
        }),
        DeleteObjectCommand: () => ({}),
      });
      await fs.rmdir("/mydir");
      expect(client.send).toHaveBeenCalledTimes(2); // list + delete
      expect(client.send.mock.calls[1][0].input.Key).toBe("mydir/.keep");
    });

    it("removes truly empty directory (no objects at all)", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({
          Contents: [],
          IsTruncated: false,
        }),
      });
      await fs.rmdir("/emptydir");
      // Only the list call, no delete needed
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it("throws DirectoryNotEmptyError when dir has files", async () => {
      const { fs } = setup({
        ListObjectsV2Command: () => ({
          Contents: [
            { Key: "mydir/.keep" },
            { Key: "mydir/file.txt" },
          ],
          IsTruncated: false,
        }),
      });
      await expect(fs.rmdir("/mydir")).rejects.toThrow(DirectoryNotEmptyError);
    });

    it("throws DirectoryNotEmptyError for files without sentinel", async () => {
      const { fs } = setup({
        ListObjectsV2Command: () => ({
          Contents: [{ Key: "mydir/file.txt" }],
          IsTruncated: false,
        }),
      });
      await expect(fs.rmdir("/mydir")).rejects.toThrow(DirectoryNotEmptyError);
    });

    it("uses MaxKeys: 2 for efficiency", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({
          Contents: [],
          IsTruncated: false,
        }),
      });
      await fs.rmdir("/d");
      expect(client.send.mock.calls[0][0].input.MaxKeys).toBe(2);
    });

    it("lists correct prefix with trailing slash", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
      });
      await fs.rmdir("/mydir");
      expect(client.send.mock.calls[0][0].input.Prefix).toBe("mydir/");
    });

    it("error message contains display path, not S3 key", async () => {
      const { fs } = setup(
        {
          ListObjectsV2Command: () => ({
            Contents: [{ Key: "pfx/mydir/file.txt" }],
            IsTruncated: false,
          }),
        },
        { prefix: "pfx" },
      );
      try {
        await fs.rmdir("/mydir");
      } catch (e: any) {
        expect(e.message).toContain("/mydir");
        expect(e.message).not.toContain("pfx/mydir");
      }
    });
  });

  describe("recursive", () => {
    it("deletes all objects under prefix", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({
          Contents: [
            { Key: "d/.keep" },
            { Key: "d/a.txt" },
            { Key: "d/sub/b.txt" },
          ],
          IsTruncated: false,
        }),
        DeleteObjectsCommand: () => ({}),
      });
      await fs.rmdir("/d", true);
      expect(client.send).toHaveBeenCalledTimes(2); // list + batch delete
      const deleteInput = client.send.mock.calls[1][0].input;
      expect(deleteInput.Delete.Objects).toHaveLength(3);
      expect(deleteInput.Delete.Quiet).toBe(true);
    });

    it("handles pagination in recursive delete", async () => {
      let page = 0;
      const { fs, client } = setup({
        ListObjectsV2Command: () => {
          page++;
          if (page === 1) {
            return {
              Contents: [{ Key: "d/a.txt" }],
              IsTruncated: true,
              NextContinuationToken: "tok",
            };
          }
          return {
            Contents: [{ Key: "d/b.txt" }],
            IsTruncated: false,
          };
        },
        DeleteObjectsCommand: () => ({}),
      });
      await fs.rmdir("/d", true);
      // 2 list calls + 2 delete calls
      expect(client.send).toHaveBeenCalledTimes(4);
    });

    it("handles empty directory in recursive mode", async () => {
      const { fs, client } = setup({
        ListObjectsV2Command: () => ({
          Contents: [],
          IsTruncated: false,
        }),
      });
      await fs.rmdir("/empty", true);
      // Only list, no delete needed
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it("uses correct prefix with prefix config", async () => {
      const { fs, client } = setup(
        {
          ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
        },
        { prefix: "pfx" },
      );
      await fs.rmdir("/mydir", true);
      expect(client.send.mock.calls[0][0].input.Prefix).toBe("pfx/mydir/");
    });
  });
});

// ─── move ──────────────────────────────────────────────────

describe("move", () => {
  it("copies then deletes", async () => {
    const { fs, client } = setup({
      CopyObjectCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    });
    await fs.move("/old.txt", "/new.txt");
    expect(client.send).toHaveBeenCalledTimes(2);
    // First call: copy
    expect(client.send.mock.calls[0][0].constructor.name).toBe("CopyObjectCommand");
    // Second call: delete
    expect(client.send.mock.calls[1][0].constructor.name).toBe("DeleteObjectCommand");
  });

  it("sends correct CopySource with bucket/key format", async () => {
    const { fs, client } = setup({
      CopyObjectCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    });
    await fs.move("/src.txt", "/dest.txt");
    const input = client.send.mock.calls[0][0].input;
    expect(input.CopySource).toBe("test-bucket/src.txt");
  });

  it("sends correct destination Key", async () => {
    const { fs, client } = setup({
      CopyObjectCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    });
    await fs.move("/old.txt", "/new/path.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("new/path.txt");
  });

  it("deletes source after copy", async () => {
    const { fs, client } = setup({
      CopyObjectCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    });
    await fs.move("/src.txt", "/dest.txt");
    expect(client.send.mock.calls[1][0].input.Key).toBe("src.txt");
  });

  it("resolves paths with prefix", async () => {
    const { fs, client } = setup(
      {
        CopyObjectCommand: () => ({}),
        DeleteObjectCommand: () => ({}),
      },
      { prefix: "pfx" },
    );
    await fs.move("/a.txt", "/b.txt");
    expect(client.send.mock.calls[0][0].input.CopySource).toBe("test-bucket/pfx/a.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("pfx/b.txt");
    expect(client.send.mock.calls[1][0].input.Key).toBe("pfx/a.txt");
  });

  it("throws NotFoundError when source doesn't exist", async () => {
    const { fs } = setup({
      CopyObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    await expect(fs.move("/missing.txt", "/dest.txt")).rejects.toThrow(NotFoundError);
  });

  it("does not delete source if copy fails", async () => {
    const { fs, client } = setup({
      CopyObjectCommand: () => { throw s3Error("NoSuchKey"); },
      DeleteObjectCommand: () => ({}),
    });
    try { await fs.move("/x", "/y"); } catch {}
    // Should only have called CopyObject, not DeleteObject
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-NoSuchKey errors", async () => {
    const { fs } = setup({
      CopyObjectCommand: () => { throw s3Error("AccessDenied"); },
    });
    await expect(fs.move("/a", "/b")).rejects.toThrow("AccessDenied");
  });

  it("NotFoundError display path strips prefix", async () => {
    const { fs } = setup(
      { CopyObjectCommand: () => { throw s3Error("NoSuchKey"); } },
      { prefix: "pfx" },
    );
    try {
      await fs.move("/src.txt", "/dest.txt");
    } catch (e: any) {
      expect(e.message).toContain("/src.txt");
      expect(e.message).not.toContain("pfx");
    }
  });
});

// ─── cd ────────────────────────────────────────────────────

describe("cd", () => {
  it("changes cwd with absolute path", () => {
    const { fs } = setup();
    fs.cd("/workspace");
    expect(fs.cwd).toBe("/workspace");
  });

  it("resolves relative paths against current cwd", () => {
    const { fs } = setup({}, { cwd: "/a/b" });
    fs.cd("../c");
    expect(fs.cwd).toBe("/a/c");
  });

  it("clamps at root", () => {
    const { fs } = setup();
    fs.cd("../../..");
    expect(fs.cwd).toBe("/");
  });

  it("sequential cds work correctly", () => {
    const { fs } = setup();
    fs.cd("/a");
    expect(fs.cwd).toBe("/a");
    fs.cd("b");
    expect(fs.cwd).toBe("/a/b");
    fs.cd("..");
    expect(fs.cwd).toBe("/a");
    fs.cd("/root");
    expect(fs.cwd).toBe("/root");
  });

  it("cd to . stays in same directory", () => {
    const { fs } = setup({}, { cwd: "/workspace" });
    fs.cd(".");
    expect(fs.cwd).toBe("/workspace");
  });

  it("cd to / goes to root", () => {
    const { fs } = setup({}, { cwd: "/deep/nested/path" });
    fs.cd("/");
    expect(fs.cwd).toBe("/");
  });

  it("cd does not make any S3 calls", () => {
    const { fs, client } = setup();
    fs.cd("/anywhere");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("cwd change affects subsequent path resolution", async () => {
    const { fs, client } = setup({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"e"',
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });
    fs.cd("/workspace");
    await fs.readFile("file.txt");
    expect(client.send.mock.calls[0][0].input.Key).toBe("workspace/file.txt");
  });
});
