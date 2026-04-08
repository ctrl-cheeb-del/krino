import { describe, it, expect } from "vitest";
import { Filesystem } from "../filesystem.js";
import { getTools } from "../tools.js";
import type { ToolDefinition } from "../types.js";
import { createMockClient, mockBody, s3Error } from "./helpers.js";

function setupTools(
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
  const tools = getTools(fs);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { tools, byName, client, fs };
}

function awsError(name: string, extras: Record<string, any> = {}): Error {
  const err = new Error(`AWS ${name}: bucket=my-secret-bucket, key=pfx/secret.txt, requestId=REQID123`);
  err.name = name;
  Object.assign(err, { $metadata: { httpStatusCode: 500, requestId: "REQID123" }, ...extras });
  return err;
}

// ─── tool definitions ──────────────────────────────────────

describe("tool definitions", () => {
  it("returns exactly 9 tools", () => {
    const { tools } = setupTools();
    expect(tools).toHaveLength(9);
  });

  it("has expected tool names", () => {
    const { tools } = setupTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "change_directory",
      "create_directory",
      "delete_file",
      "file_exists",
      "list_directory",
      "move_file",
      "read_file",
      "remove_directory",
      "write_file",
    ]);
  });

  it("all tool names are snake_case", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("all tools have description, inputSchema, and execute", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });

  it("all inputSchemas have required array", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });

  it("all property descriptions are strings", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      const props = t.inputSchema.properties as Record<string, any>;
      for (const [key, prop] of Object.entries(props)) {
        expect(typeof prop.description).toBe("string");
        expect(prop.type).toBeDefined();
      }
    }
  });
});

// ─── security: no S3 concepts leak ─────────────────────────

describe("security: no S3/infra concepts leak to model", () => {
  it("no tool description mentions S3, ETag, bucket, R2, or AWS", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      const desc = t.description.toLowerCase();
      expect(desc).not.toContain("s3");
      expect(desc).not.toContain("etag");
      expect(desc).not.toContain("bucket");
      expect(desc).not.toContain("r2");
      expect(desc).not.toContain("aws");
      expect(desc).not.toContain("cloudflare");
      expect(desc).not.toContain("object storage");
    }
  });

  it("no parameter description mentions S3, ETag, bucket, or AWS", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      const props = t.inputSchema.properties as Record<string, any>;
      for (const prop of Object.values(props)) {
        const desc = (prop.description ?? "").toLowerCase();
        expect(desc).not.toContain("s3");
        expect(desc).not.toContain("etag");
        expect(desc).not.toContain("bucket");
        expect(desc).not.toContain("aws");
      }
    }
  });

  it("no tool exposes etag, if_match, or content_type parameters", () => {
    const { tools } = setupTools();
    for (const t of tools) {
      const paramNames = Object.keys(t.inputSchema.properties as Record<string, any>);
      expect(paramNames).not.toContain("if_match");
      expect(paramNames).not.toContain("etag");
      expect(paramNames).not.toContain("content_type");
      expect(paramNames).not.toContain("ifMatch");
      expect(paramNames).not.toContain("contentType");
    }
  });

  it("no tool response ever contains etag on success", async () => {
    const { byName } = setupTools({
      GetObjectCommand: () => ({
        Body: mockBody("data"),
        ETag: '"secret-etag-value"',
        ContentLength: 4,
        LastModified: new Date(),
      }),
      PutObjectCommand: () => ({ ETag: '"new-etag"' }),
      HeadObjectCommand: () => ({}),
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/f.txt", Size: 1 }],
        IsTruncated: false,
      }),
      DeleteObjectCommand: () => ({}),
      CopyObjectCommand: () => ({}),
    });

    const results = await Promise.all([
      byName.read_file.execute({ path: "/f" }),
      byName.write_file.execute({ path: "/f", content: "x" }),
      byName.delete_file.execute({ path: "/f" }),
      byName.file_exists.execute({ path: "/f" }),
      byName.list_directory.execute({ path: "/d" }),
      byName.create_directory.execute({ path: "/d" }),
      byName.change_directory.execute({ path: "/d" }),
    ]);

    for (const result of results) {
      expect(result.toLowerCase()).not.toContain("etag");
      expect(result).not.toContain("secret-etag-value");
      expect(result).not.toContain("new-etag");
    }
  });

  describe("AWS error sanitization for every tool", () => {
    const awsErr = () => awsError("AccessDenied");

    it("read_file sanitizes AWS errors", async () => {
      const { byName } = setupTools({ GetObjectCommand: () => { throw awsErr(); } });
      const result = await byName.read_file.execute({ path: "/f" });
      expect(result).toBe("Error: Operation failed. Please try again.");
      expect(result).not.toContain("my-secret-bucket");
      expect(result).not.toContain("REQID123");
    });

    it("write_file sanitizes AWS errors", async () => {
      const { byName } = setupTools({ PutObjectCommand: () => { throw awsErr(); } });
      const result = await byName.write_file.execute({ path: "/f", content: "x" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("delete_file sanitizes AWS errors", async () => {
      const { byName } = setupTools({ DeleteObjectCommand: () => { throw awsErr(); } });
      const result = await byName.delete_file.execute({ path: "/f" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("file_exists sanitizes AWS errors", async () => {
      // exists uses HeadObject which can fail with non-NotFound errors
      const { byName } = setupTools({
        HeadObjectCommand: () => { throw awsErr(); },
      });
      // exists catches NotFound internally, but AccessDenied should be caught by tools
      const result = await byName.file_exists.execute({ path: "/f" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("list_directory sanitizes AWS errors", async () => {
      const { byName } = setupTools({ ListObjectsV2Command: () => { throw awsErr(); } });
      const result = await byName.list_directory.execute({ path: "/d" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("create_directory sanitizes AWS errors", async () => {
      const { byName } = setupTools({ PutObjectCommand: () => { throw awsErr(); } });
      const result = await byName.create_directory.execute({ path: "/d" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("remove_directory sanitizes AWS errors", async () => {
      const { byName } = setupTools({ ListObjectsV2Command: () => { throw awsErr(); } });
      const result = await byName.remove_directory.execute({ path: "/d" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });

    it("move_file sanitizes AWS errors", async () => {
      const { byName } = setupTools({ CopyObjectCommand: () => { throw awsErr(); } });
      const result = await byName.move_file.execute({ from_path: "/a", to_path: "/b" });
      expect(result).toBe("Error: Operation failed. Please try again.");
    });
  });
});

// ─── tools never throw ─────────────────────────────────────

describe("tools never throw (always return strings)", () => {
  it("read_file returns string on error, does not throw", async () => {
    const { byName } = setupTools({
      GetObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    const result = await byName.read_file.execute({ path: "/nope" });
    expect(typeof result).toBe("string");
  });

  it("write_file returns string on error, does not throw", async () => {
    const { byName } = setupTools({
      PutObjectCommand: () => { throw s3Error("PreconditionFailed"); },
    });
    const result = await byName.write_file.execute({ path: "/f", content: "x" });
    expect(typeof result).toBe("string");
  });

  it("move_file returns string on error, does not throw", async () => {
    const { byName } = setupTools({
      CopyObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    const result = await byName.move_file.execute({ from_path: "/a", to_path: "/b" });
    expect(typeof result).toBe("string");
  });

  it("remove_directory returns string on error, does not throw", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/.keep" }, { Key: "d/f.txt" }],
        IsTruncated: false,
      }),
    });
    const result = await byName.remove_directory.execute({ path: "/d" });
    expect(typeof result).toBe("string");
  });
});

// ─── read_file ─────────────────────────────────────────────

describe("read_file", () => {
  it("returns raw file content string", async () => {
    const { byName } = setupTools({
      GetObjectCommand: () => ({
        Body: mockBody("hello world"),
        ETag: '"e1"',
        ContentLength: 11,
        LastModified: new Date(),
      }),
    });
    expect(await byName.read_file.execute({ path: "/f.txt" })).toBe("hello world");
  });

  it("returns empty string for empty file", async () => {
    const { byName } = setupTools({
      GetObjectCommand: () => ({
        Body: mockBody(""),
        ETag: '"e"',
        ContentLength: 0,
        LastModified: new Date(),
      }),
    });
    expect(await byName.read_file.execute({ path: "/empty" })).toBe("");
  });

  it("returns multiline content as-is", async () => {
    const content = "line 1\nline 2\nline 3";
    const { byName } = setupTools({
      GetObjectCommand: () => ({
        Body: mockBody(content),
        ETag: '"e"',
        ContentLength: content.length,
        LastModified: new Date(),
      }),
    });
    expect(await byName.read_file.execute({ path: "/f" })).toBe(content);
  });

  it("returns error string on not found", async () => {
    const { byName } = setupTools({
      GetObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    const result = await byName.read_file.execute({ path: "/nope" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("Not found");
  });

  it("blocks .keep sentinel reads", async () => {
    const { byName } = setupTools({});
    const result = await byName.read_file.execute({ path: "/dir/.keep" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("Not found");
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.read_file.inputSchema.required).toContain("path");
  });
});

// ─── write_file ────────────────────────────────────────────

describe("write_file", () => {
  it("returns success message", async () => {
    const { byName } = setupTools({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    expect(await byName.write_file.execute({ path: "/f", content: "data" })).toBe(
      "File written successfully.",
    );
  });

  it("writes empty content", async () => {
    const { byName, client } = setupTools({
      PutObjectCommand: () => ({ ETag: '"e"' }),
    });
    await byName.write_file.execute({ path: "/f", content: "" });
    expect(client.send.mock.calls[0][0].input.Body).toBe("");
  });

  it("returns error on conflict", async () => {
    const { byName } = setupTools({
      PutObjectCommand: () => { throw s3Error("PreconditionFailed"); },
    });
    // Even though tools don't expose ifMatch, the Filesystem might get
    // a PreconditionFailed in future (or from SDK bugs). Tool should handle it.
    const result = await byName.write_file.execute({ path: "/f", content: "x" });
    expect(result).toMatch(/^Error:/);
  });

  it("schema requires path and content", () => {
    const { byName } = setupTools();
    expect(byName.write_file.inputSchema.required).toContain("path");
    expect(byName.write_file.inputSchema.required).toContain("content");
  });
});

// ─── delete_file ───────────────────────────────────────────

describe("delete_file", () => {
  it("returns success message", async () => {
    const { byName } = setupTools({
      DeleteObjectCommand: () => ({}),
    });
    expect(await byName.delete_file.execute({ path: "/f" })).toBe("File deleted.");
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.delete_file.inputSchema.required).toContain("path");
  });
});

// ─── file_exists ───────────────────────────────────────────

describe("file_exists", () => {
  it("returns 'true' when file exists", async () => {
    const { byName } = setupTools({
      HeadObjectCommand: () => ({}),
    });
    expect(await byName.file_exists.execute({ path: "/f" })).toBe("true");
  });

  it("returns 'false' when file does not exist", async () => {
    const { byName } = setupTools({
      HeadObjectCommand: () => { throw s3Error("NotFound"); },
    });
    expect(await byName.file_exists.execute({ path: "/f" })).toBe("false");
  });

  it("returns 'true' when directory exists (via .keep)", async () => {
    let calls = 0;
    const { byName } = setupTools({
      HeadObjectCommand: () => {
        calls++;
        if (calls === 1) throw s3Error("NotFound");
        return {};
      },
    });
    expect(await byName.file_exists.execute({ path: "/dir" })).toBe("true");
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.file_exists.inputSchema.required).toContain("path");
  });
});

// ─── list_directory ────────────────────────────────────────

describe("list_directory", () => {
  it("returns newline-separated file and directory names", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: "d/file.txt", Size: 10, LastModified: new Date() },
          { Key: "d/data.json", Size: 20, LastModified: new Date() },
        ],
        CommonPrefixes: [{ Prefix: "d/sub/" }],
        IsTruncated: false,
      }),
    });
    const result = await byName.list_directory.execute({ path: "/d" });
    expect(result).toBe("file.txt\ndata.json\nsub/");
  });

  it("appends / to directory names", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        CommonPrefixes: [{ Prefix: "d/images/" }, { Prefix: "d/docs/" }],
        IsTruncated: false,
      }),
    });
    const result = await byName.list_directory.execute({ path: "/d" });
    expect(result).toBe("images/\ndocs/");
  });

  it("returns (empty directory) for empty dir", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/.keep", Size: 0 }],
        IsTruncated: false,
      }),
    });
    expect(await byName.list_directory.execute({ path: "/d" })).toBe("(empty directory)");
  });

  it("returns (empty directory) when truly empty", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({ IsTruncated: false }),
    });
    expect(await byName.list_directory.execute({ path: "/d" })).toBe("(empty directory)");
  });

  it("lists cwd when no path given", async () => {
    const { byName, client } = setupTools(
      { ListObjectsV2Command: () => ({ IsTruncated: false }) },
      { cwd: "/workspace" },
    );
    await byName.list_directory.execute({});
    expect(client.send.mock.calls[0][0].input.Prefix).toBe("workspace/");
  });

  it("path is optional in schema", () => {
    const { byName } = setupTools();
    expect(byName.list_directory.inputSchema.required).not.toContain("path");
  });
});

// ─── create_directory ──────────────────────────────────────

describe("create_directory", () => {
  it("returns success message", async () => {
    const { byName } = setupTools({
      PutObjectCommand: () => ({}),
    });
    expect(await byName.create_directory.execute({ path: "/newdir" })).toBe("Directory created.");
  });

  it("sends correct .keep sentinel key", async () => {
    const { byName, client } = setupTools({
      PutObjectCommand: () => ({}),
    });
    await byName.create_directory.execute({ path: "/mydir" });
    expect(client.send.mock.calls[0][0].input.Key).toBe("mydir/.keep");
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.create_directory.inputSchema.required).toContain("path");
  });
});

// ─── remove_directory ──────────────────────────────────────

describe("remove_directory", () => {
  it("returns success when empty", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/.keep" }],
        IsTruncated: false,
      }),
      DeleteObjectCommand: () => ({}),
    });
    expect(await byName.remove_directory.execute({ path: "/d" })).toBe("Directory removed.");
  });

  it("returns error when not empty and not recursive", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/.keep" }, { Key: "d/file.txt" }],
        IsTruncated: false,
      }),
    });
    const result = await byName.remove_directory.execute({ path: "/d" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("not empty");
  });

  it("recursive=true deletes everything", async () => {
    const { byName, client } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: "d/.keep" },
          { Key: "d/a.txt" },
          { Key: "d/b.txt" },
        ],
        IsTruncated: false,
      }),
      DeleteObjectsCommand: () => ({}),
    });
    const result = await byName.remove_directory.execute({ path: "/d", recursive: true });
    expect(result).toBe("Directory removed.");
  });

  it("recursive defaults to false", async () => {
    const { byName } = setupTools({
      ListObjectsV2Command: () => ({
        Contents: [{ Key: "d/.keep" }, { Key: "d/file.txt" }],
        IsTruncated: false,
      }),
    });
    // No recursive param → should fail on non-empty
    const result = await byName.remove_directory.execute({ path: "/d" });
    expect(result).toMatch(/Error/);
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.remove_directory.inputSchema.required).toContain("path");
  });
});

// ─── move_file ─────────────────────────────────────────────

describe("move_file", () => {
  it("returns success message", async () => {
    const { byName } = setupTools({
      CopyObjectCommand: () => ({}),
      DeleteObjectCommand: () => ({}),
    });
    expect(
      await byName.move_file.execute({ from_path: "/a.txt", to_path: "/b.txt" }),
    ).toBe("File moved.");
  });

  it("returns error when source not found", async () => {
    const { byName } = setupTools({
      CopyObjectCommand: () => { throw s3Error("NoSuchKey"); },
    });
    const result = await byName.move_file.execute({ from_path: "/missing", to_path: "/dest" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("Not found");
  });

  it("schema requires from_path and to_path", () => {
    const { byName } = setupTools();
    expect(byName.move_file.inputSchema.required).toContain("from_path");
    expect(byName.move_file.inputSchema.required).toContain("to_path");
  });
});

// ─── change_directory ──────────────────────────────────────

describe("change_directory", () => {
  it("returns the new cwd path", async () => {
    const { byName } = setupTools();
    expect(await byName.change_directory.execute({ path: "/workspace" })).toBe("/workspace");
  });

  it("resolves relative paths", async () => {
    const { byName } = setupTools({}, { cwd: "/a/b" });
    expect(await byName.change_directory.execute({ path: "../c" })).toBe("/a/c");
  });

  it("returns / when clamped at root", async () => {
    const { byName } = setupTools();
    expect(await byName.change_directory.execute({ path: "../../.." })).toBe("/");
  });

  it("sequential cd calls accumulate", async () => {
    const { byName } = setupTools();
    await byName.change_directory.execute({ path: "/a" });
    const result = await byName.change_directory.execute({ path: "b" });
    expect(result).toBe("/a/b");
  });

  it("schema requires path", () => {
    const { byName } = setupTools();
    expect(byName.change_directory.inputSchema.required).toContain("path");
  });
});

// ─── workflow: tools work together ─────────────────────────

describe("end-to-end workflow", () => {
  it("mkdir → write → list → read → move → delete → rmdir", async () => {
    const store: Record<string, string> = {};
    const { byName } = setupTools({
      PutObjectCommand: (input: any) => {
        store[input.Key] = input.Body;
        return { ETag: '"e1"' };
      },
      GetObjectCommand: (input: any) => {
        if (!(input.Key in store)) throw s3Error("NoSuchKey");
        return {
          Body: mockBody(store[input.Key]),
          ETag: '"e1"',
          ContentLength: store[input.Key].length,
          LastModified: new Date(),
        };
      },
      ListObjectsV2Command: (input: any) => {
        const prefix = input.Prefix ?? "";
        const keys = Object.keys(store).filter((k) => k.startsWith(prefix));
        return {
          Contents: keys
            .filter((k) => !k.slice(prefix.length).includes("/"))
            .map((k) => ({ Key: k, Size: store[k].length })),
          CommonPrefixes: [],
          IsTruncated: false,
        };
      },
      CopyObjectCommand: (input: any) => {
        const src = input.CopySource.split("/").slice(1).join("/");
        if (!(src in store)) throw s3Error("NoSuchKey");
        store[input.Key] = store[src];
        return {};
      },
      DeleteObjectCommand: (input: any) => {
        delete store[input.Key];
        return {};
      },
    });

    // Create directory
    expect(await byName.create_directory.execute({ path: "/workspace" })).toBe("Directory created.");

    // Write file
    expect(
      await byName.write_file.execute({ path: "/workspace/hello.txt", content: "Hello!" }),
    ).toBe("File written successfully.");

    // List directory
    const listing = await byName.list_directory.execute({ path: "/workspace" });
    expect(listing).toContain("hello.txt");

    // Read file
    expect(await byName.read_file.execute({ path: "/workspace/hello.txt" })).toBe("Hello!");

    // Move file
    expect(
      await byName.move_file.execute({
        from_path: "/workspace/hello.txt",
        to_path: "/workspace/renamed.txt",
      }),
    ).toBe("File moved.");

    // Original is gone
    const readOld = await byName.read_file.execute({ path: "/workspace/hello.txt" });
    expect(readOld).toMatch(/Error.*Not found/);

    // Renamed exists
    expect(await byName.read_file.execute({ path: "/workspace/renamed.txt" })).toBe("Hello!");

    // Delete file
    expect(await byName.delete_file.execute({ path: "/workspace/renamed.txt" })).toBe(
      "File deleted.",
    );

    // File is gone
    const readDeleted = await byName.read_file.execute({ path: "/workspace/renamed.txt" });
    expect(readDeleted).toMatch(/Error.*Not found/);
  });

  it("cwd set by change_directory affects subsequent tool calls", async () => {
    const { byName, client } = setupTools({
      GetObjectCommand: () => ({
        Body: mockBody("x"),
        ETag: '"e"',
        ContentLength: 1,
        LastModified: new Date(),
      }),
    });

    await byName.change_directory.execute({ path: "/project/src" });
    await byName.read_file.execute({ path: "index.ts" });

    // The read should have resolved to project/src/index.ts
    expect(client.send.mock.calls[0][0].input.Key).toBe("project/src/index.ts");
  });
});
