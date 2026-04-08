import { describe, it, expect } from "vitest";
import { Filesystem } from "../filesystem.js";
import { getShellTool } from "../shell.js";
import { MemoryStore } from "../../eval/memory-store.js";

function setup(files: Record<string, string> = {}, opts: { prefix?: string } = {}) {
  const store = new MemoryStore();
  store.seed(files);
  const fs = new Filesystem({ bucket: "test", client: store as any, prefix: opts.prefix });
  const shell = getShellTool(fs);
  const run = (cmd: string) => shell.execute({ command: cmd });
  return { fs, store, run };
}

// ─── tool definition ───────────────────────────────────────

describe("shell tool definition", () => {
  it("has correct name", () => {
    const tool = getShellTool(new Filesystem({ bucket: "b", client: new MemoryStore() as any }));
    expect(tool.name).toBe("run_command");
  });

  it("schema requires command", () => {
    const tool = getShellTool(new Filesystem({ bucket: "b", client: new MemoryStore() as any }));
    expect(tool.inputSchema.required).toContain("command");
    expect((tool.inputSchema.properties as any).command.type).toBe("string");
  });

  it("has description", () => {
    const tool = getShellTool(new Filesystem({ bucket: "b", client: new MemoryStore() as any }));
    expect(tool.description.length).toBeGreaterThan(20);
  });

  it("description has no S3/infra concepts", () => {
    const tool = getShellTool(new Filesystem({ bucket: "b", client: new MemoryStore() as any }));
    const d = tool.description.toLowerCase();
    expect(d).not.toContain("s3");
    expect(d).not.toContain("bucket");
    expect(d).not.toContain("r2");
    expect(d).not.toContain("etag");
    expect(d).not.toContain("aws");
    expect(d).not.toContain("cloudflare");
  });

  it("description mentions pipes and heredocs", () => {
    const tool = getShellTool(new Filesystem({ bucket: "b", client: new MemoryStore() as any }));
    const d = tool.description.toLowerCase();
    expect(d).toContain("pipe");
    expect(d).toContain("heredoc");
    expect(d).toContain("sed");
    expect(d).toContain("diff");
  });
});

// ─── ls ────────────────────────────────────────────────────

describe("ls", () => {
  it("lists files and directories", async () => {
    const { run } = setup({
      "src/a.txt": "a",
      "src/b.txt": "b",
      "src/sub/.keep": "",
    });
    const result = await run("ls /src");
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
    expect(result).toContain("sub/");
  });

  it("directories have trailing / in short format", async () => {
    const { run } = setup({ "d/sub/.keep": "" });
    const result = await run("ls /d");
    expect(result).toContain("sub/");
  });

  it("short format is space-separated", async () => {
    const { run } = setup({
      "d/a.txt": "a",
      "d/b.txt": "b",
    });
    const result = await run("ls /d");
    expect(result).toBe("a.txt  b.txt");
  });

  it("ls -l shows long format with permissions", async () => {
    const { run } = setup({
      "file.txt": "hello",
      "dir/.keep": "",
    });
    const result = await run("ls -l /");
    expect(result).toContain("-rw-r--r--");
    expect(result).toContain("file.txt");
    expect(result).toContain("5"); // size
  });

  it("ls -l shows drwxr-xr-x for directories", async () => {
    const { run } = setup({ "d/sub/.keep": "" });
    const result = await run("ls -l /d");
    expect(result).toContain("drwxr-xr-x");
    expect(result).toContain("sub/");
  });

  it("ls -l shows date in ISO format", async () => {
    const { run } = setup({ "f.txt": "x" });
    const result = await run("ls -l /");
    // Should have a YYYY-MM-DD date
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("ls -l shows user user", async () => {
    const { run } = setup({ "f.txt": "x" });
    const result = await run("ls -l /");
    expect(result).toContain("user user");
  });

  it("ls -la combines flags", async () => {
    const { run } = setup({ "f.txt": "x" });
    const result = await run("ls -la /");
    expect(result).toContain("-rw-r--r--");
    expect(result).toContain("f.txt");
  });

  it("ls empty dir returns empty string", async () => {
    const { run } = setup({ "dir/.keep": "" });
    expect(await run("ls /dir")).toBe("");
  });

  it("ls with no args lists cwd", async () => {
    const { run, fs } = setup({ "workspace/f.txt": "x" });
    fs.cd("/workspace");
    const result = await run("ls");
    expect(result).toContain("f.txt");
  });

  it("ls with relative path", async () => {
    const { run, fs } = setup({
      "a/b/f.txt": "x",
    });
    fs.cd("/a");
    const result = await run("ls b");
    expect(result).toContain("f.txt");
  });

  it("ls filters out .keep sentinels", async () => {
    const { run } = setup({
      "d/.keep": "",
      "d/real.txt": "data",
    });
    const result = await run("ls /d");
    expect(result).not.toContain(".keep");
    expect(result).toContain("real.txt");
  });
});

// ─── cat ───────────────────────────────────────────────────

describe("cat", () => {
  it("outputs file content", async () => {
    const { run } = setup({ "hello.txt": "Hello, World!" });
    expect(await run("cat /hello.txt")).toBe("Hello, World!");
  });

  it("cat multiple files concatenated", async () => {
    const { run } = setup({
      "a.txt": "aaa",
      "b.txt": "bbb",
    });
    const result = await run("cat /a.txt /b.txt");
    expect(result).toContain("aaa");
    expect(result).toContain("bbb");
  });

  it("cat empty file returns empty string", async () => {
    const { run } = setup({ "empty.txt": "" });
    expect(await run("cat /empty.txt")).toBe("");
  });

  it("cat missing file returns error", async () => {
    const { run } = setup();
    const result = await run("cat /nope.txt");
    expect(result).toContain("Not found");
  });

  it("cat no args returns missing operand", async () => {
    const { run } = setup();
    expect(await run("cat")).toContain("missing operand");
  });

  it("cat with relative path", async () => {
    const { run, fs } = setup({ "d/f.txt": "content" });
    fs.cd("/d");
    expect(await run("cat f.txt")).toBe("content");
  });

  it("cat skips flag arguments", async () => {
    const { run } = setup({ "f.txt": "data" });
    // cat -n is commonly used but we skip flags
    const result = await run("cat -n /f.txt");
    expect(result).toBe("data");
  });

  it("cat multiline file preserves content", async () => {
    const content = "line 1\nline 2\nline 3";
    const { run } = setup({ "f.txt": content });
    expect(await run("cat /f.txt")).toBe(content);
  });

  it("cat > redirect returns error message", async () => {
    const { run } = setup();
    const result = await run("cat > /f.txt");
    expect(result).toContain("not supported");
  });
});

// ─── head ──────────────────────────────────────────────────

describe("head", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  it("shows first 10 lines by default", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("head /f.txt");
    const lines = result.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 1");
    expect(lines[9]).toBe("line 10");
  });

  it("head -n 3 shows first 3 lines", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("head -n 3 /f.txt");
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("line 1");
    expect(lines[2]).toBe("line 3");
  });

  it("head -5 shorthand shows first 5 lines", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("head -5 /f.txt");
    expect(result.split("\n")).toHaveLength(5);
  });

  it("head -n 1 shows single line", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("head -n 1 /f.txt");
    expect(result).toBe("line 1");
  });

  it("head on short file returns all lines", async () => {
    const { run } = setup({ "f.txt": "one\ntwo" });
    const result = await run("head /f.txt");
    expect(result).toBe("one\ntwo");
  });

  it("head no args returns error", async () => {
    const { run } = setup();
    expect(await run("head")).toContain("missing operand");
  });

  it("head with relative path", async () => {
    const { run, fs } = setup({ "d/f.txt": "first line\nsecond line" });
    fs.cd("/d");
    const result = await run("head -n 1 f.txt");
    expect(result).toBe("first line");
  });

  it("head on missing file returns error", async () => {
    const { run } = setup();
    const result = await run("head /nope.txt");
    expect(result).toContain("Not found");
  });
});

// ─── tail ──────────────────────────────────────────────────

describe("tail", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  it("shows last 10 lines by default", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("tail /f.txt");
    const lines = result.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 11");
    expect(lines[9]).toBe("line 20");
  });

  it("tail -n 3 shows last 3 lines", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("tail -n 3 /f.txt");
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("line 18");
    expect(lines[2]).toBe("line 20");
  });

  it("tail -5 shorthand shows last 5 lines", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("tail -5 /f.txt");
    expect(result.split("\n")).toHaveLength(5);
    expect(result).toContain("line 20");
    expect(result).toContain("line 16");
  });

  it("tail -n 1 shows single line", async () => {
    const { run } = setup({ "f.txt": content });
    expect(await run("tail -n 1 /f.txt")).toBe("line 20");
  });

  it("tail on short file returns all lines", async () => {
    const { run } = setup({ "f.txt": "one\ntwo" });
    expect(await run("tail /f.txt")).toBe("one\ntwo");
  });

  it("tail no args returns error", async () => {
    const { run } = setup();
    expect(await run("tail")).toContain("missing operand");
  });

  it("tail on missing file returns error", async () => {
    const { run } = setup();
    const result = await run("tail /nope.txt");
    expect(result).toContain("Not found");
  });
});

// ─── mkdir ─────────────────────────────────────────────────

describe("mkdir", () => {
  it("creates a directory", async () => {
    const { run, fs } = setup();
    await run("mkdir /newdir");
    expect(await fs.exists("/newdir")).toBe(true);
  });

  it("mkdir -p works (idempotent)", async () => {
    const { run, fs } = setup();
    await run("mkdir -p /a/b/c");
    expect(await fs.exists("/a/b/c")).toBe(true);
  });

  it("mkdir multiple dirs", async () => {
    const { run, fs } = setup();
    await run("mkdir /dir1 /dir2 /dir3");
    expect(await fs.exists("/dir1")).toBe(true);
    expect(await fs.exists("/dir2")).toBe(true);
    expect(await fs.exists("/dir3")).toBe(true);
  });

  it("mkdir returns empty string on success", async () => {
    const { run } = setup();
    expect(await run("mkdir /d")).toBe("");
  });

  it("mkdir no args returns error", async () => {
    const { run } = setup();
    expect(await run("mkdir")).toContain("missing operand");
  });

  it("mkdir with relative path", async () => {
    const { run, fs, store } = setup();
    fs.cd("/workspace");
    await run("mkdir subdir");
    expect(store.has("workspace/subdir/.keep")).toBe(true);
  });
});

// ─── rm ────────────────────────────────────────────────────

describe("rm", () => {
  it("removes a file", async () => {
    const { run, fs } = setup({ "f.txt": "data" });
    await run("rm /f.txt");
    expect(await fs.exists("/f.txt")).toBe(false);
  });

  it("rm multiple files", async () => {
    const { run, fs } = setup({ "a.txt": "a", "b.txt": "b" });
    await run("rm /a.txt /b.txt");
    expect(await fs.exists("/a.txt")).toBe(false);
    expect(await fs.exists("/b.txt")).toBe(false);
  });

  it("rm -r removes directory recursively", async () => {
    const { run, store } = setup({
      "dir/.keep": "",
      "dir/a.txt": "a",
    });
    await run("rm -r /dir");
    expect(store.has("dir/a.txt")).toBe(false);
    expect(store.has("dir/.keep")).toBe(false);
  });

  it("rm -R (capital) also works", async () => {
    const { run, store } = setup({
      "dir/.keep": "",
      "dir/a.txt": "a",
    });
    await run("rm -R /dir");
    expect(store.has("dir/a.txt")).toBe(false);
  });

  it("rm -rf removes everything", async () => {
    const { run, store } = setup({
      "dir/.keep": "",
      "dir/a.txt": "a",
      "dir/sub/b.txt": "b",
    });
    await run("rm -rf /dir");
    expect(store.has("dir/a.txt")).toBe(false);
    expect(store.has("dir/sub/b.txt")).toBe(false);
  });

  it("rm -f ignores missing files", async () => {
    const { run } = setup();
    expect(await run("rm -f /nope.txt")).toBe("");
  });

  it("rm returns empty string on success", async () => {
    const { run } = setup({ "f.txt": "x" });
    expect(await run("rm /f.txt")).toBe("");
  });

  it("rm no args returns error", async () => {
    const { run } = setup();
    expect(await run("rm")).toContain("missing operand");
  });
});

// ─── rmdir ─────────────────────────────────────────────────

describe("rmdir", () => {
  it("removes empty directory", async () => {
    const { run, store } = setup({ "d/.keep": "" });
    await run("rmdir /d");
    expect(store.has("d/.keep")).toBe(false);
  });

  it("fails on non-empty directory", async () => {
    const { run } = setup({
      "d/.keep": "",
      "d/f.txt": "x",
    });
    const result = await run("rmdir /d");
    expect(result).toContain("not empty");
  });

  it("rmdir multiple dirs", async () => {
    const { run, store } = setup({
      "a/.keep": "",
      "b/.keep": "",
    });
    await run("rmdir /a /b");
    expect(store.has("a/.keep")).toBe(false);
    expect(store.has("b/.keep")).toBe(false);
  });

  it("rmdir returns empty on success", async () => {
    const { run } = setup({ "d/.keep": "" });
    expect(await run("rmdir /d")).toBe("");
  });

  it("rmdir no args returns error", async () => {
    const { run } = setup();
    expect(await run("rmdir")).toContain("missing operand");
  });
});

// ─── mv ────────────────────────────────────────────────────

describe("mv", () => {
  it("moves/renames a file", async () => {
    const { run, fs } = setup({ "old.txt": "content" });
    await run("mv /old.txt /new.txt");
    expect(await fs.exists("/old.txt")).toBe(false);
    expect((await fs.readFile("/new.txt")).content).toBe("content");
  });

  it("mv returns empty on success", async () => {
    const { run } = setup({ "a.txt": "x" });
    expect(await run("mv /a.txt /b.txt")).toBe("");
  });

  it("mv missing source returns error", async () => {
    const { run } = setup();
    const result = await run("mv /nope.txt /dest.txt");
    expect(result).toContain("Not found");
  });

  it("mv missing operand returns error", async () => {
    const { run } = setup();
    expect(await run("mv")).toContain("missing operand");
    expect(await run("mv /only-one")).toContain("missing operand");
  });

  it("mv with relative paths", async () => {
    const { run, fs } = setup({ "d/a.txt": "data" });
    fs.cd("/d");
    await run("mv a.txt b.txt");
    expect((await fs.readFile("/d/b.txt")).content).toBe("data");
  });
});

// ─── cp ────────────────────────────────────────────────────

describe("cp", () => {
  it("copies a file", async () => {
    const { run, fs } = setup({ "src.txt": "data" });
    await run("cp /src.txt /dest.txt");
    expect((await fs.readFile("/src.txt")).content).toBe("data");
    expect((await fs.readFile("/dest.txt")).content).toBe("data");
  });

  it("cp returns empty on success", async () => {
    const { run } = setup({ "a.txt": "x" });
    expect(await run("cp /a.txt /b.txt")).toBe("");
  });

  it("cp missing source returns error", async () => {
    const { run } = setup();
    const result = await run("cp /nope.txt /dest.txt");
    expect(result).toContain("Not found");
  });

  it("cp missing operand returns error", async () => {
    const { run } = setup();
    expect(await run("cp")).toContain("missing operand");
    expect(await run("cp /only-one")).toContain("missing operand");
  });

  it("cp with relative paths", async () => {
    const { run, fs } = setup({ "d/a.txt": "data" });
    fs.cd("/d");
    await run("cp a.txt b.txt");
    expect((await fs.readFile("/d/a.txt")).content).toBe("data");
    expect((await fs.readFile("/d/b.txt")).content).toBe("data");
  });

  it("cp overwrites destination", async () => {
    const { run, fs } = setup({ "src.txt": "new", "dest.txt": "old" });
    await run("cp /src.txt /dest.txt");
    expect((await fs.readFile("/dest.txt")).content).toBe("new");
  });
});

// ─── touch ─────────────────────────────────────────────────

describe("touch", () => {
  it("creates an empty file", async () => {
    const { run, fs } = setup();
    await run("touch /new.txt");
    expect((await fs.readFile("/new.txt")).content).toBe("");
  });

  it("does not overwrite existing file", async () => {
    const { run, fs } = setup({ "exists.txt": "keep me" });
    await run("touch /exists.txt");
    expect((await fs.readFile("/exists.txt")).content).toBe("keep me");
  });

  it("touch multiple files", async () => {
    const { run, fs } = setup();
    await run("touch /a.txt /b.txt /c.txt");
    expect(await fs.exists("/a.txt")).toBe(true);
    expect(await fs.exists("/b.txt")).toBe(true);
    expect(await fs.exists("/c.txt")).toBe(true);
  });

  it("touch returns empty on success", async () => {
    const { run } = setup();
    expect(await run("touch /f.txt")).toBe("");
  });

  it("touch no args returns error", async () => {
    const { run } = setup();
    expect(await run("touch")).toContain("missing operand");
  });

  it("touch with relative path", async () => {
    const { run, fs } = setup();
    fs.cd("/workspace");
    await run("touch f.txt");
    expect(await fs.exists("/workspace/f.txt")).toBe(true);
  });
});

// ─── pwd ───────────────────────────────────────────────────

describe("pwd", () => {
  it("returns / by default", async () => {
    const { run } = setup();
    expect(await run("pwd")).toBe("/");
  });

  it("reflects cd changes", async () => {
    const { run } = setup();
    await run("cd /workspace");
    expect(await run("pwd")).toBe("/workspace");
  });

  it("reflects multiple cd changes", async () => {
    const { run } = setup();
    await run("cd /a");
    await run("cd b");
    await run("cd c");
    expect(await run("pwd")).toBe("/a/b/c");
  });

  it("reflects cd ..", async () => {
    const { run } = setup();
    await run("cd /a/b/c");
    await run("cd ..");
    expect(await run("pwd")).toBe("/a/b");
  });
});

// ─── cd ────────────────────────────────────────────────────

describe("cd", () => {
  it("changes to absolute path", async () => {
    const { run, fs } = setup();
    await run("cd /src/components");
    expect(fs.cwd).toBe("/src/components");
  });

  it("changes to relative path", async () => {
    const { run, fs } = setup();
    await run("cd /a");
    await run("cd b");
    expect(fs.cwd).toBe("/a/b");
  });

  it("cd with no args goes to root", async () => {
    const { run, fs } = setup();
    await run("cd /deep/nested/path");
    await run("cd");
    expect(fs.cwd).toBe("/");
  });

  it("cd .. goes up one level", async () => {
    const { run, fs } = setup();
    await run("cd /a/b/c");
    await run("cd ..");
    expect(fs.cwd).toBe("/a/b");
  });

  it("cd . stays in same directory", async () => {
    const { run, fs } = setup();
    await run("cd /workspace");
    await run("cd .");
    expect(fs.cwd).toBe("/workspace");
  });

  it("cd returns empty string (silent like bash)", async () => {
    const { run } = setup();
    expect(await run("cd /anywhere")).toBe("");
  });

  it("cd clamps at root", async () => {
    const { run, fs } = setup();
    await run("cd /a");
    await run("cd ../../../../../../..");
    expect(fs.cwd).toBe("/");
  });
});

// ─── echo ──────────────────────────────────────────────────

describe("echo", () => {
  it("echoes text", async () => {
    const { run } = setup();
    expect(await run("echo hello world")).toBe("hello world");
  });

  it("echo with no args returns empty", async () => {
    const { run } = setup();
    expect(await run("echo")).toBe("");
  });

  it("echo with double-quoted redirect writes file", async () => {
    const { run, fs } = setup();
    await run('echo "hello" > /out.txt');
    expect((await fs.readFile("/out.txt")).content).toBe("hello\n");
  });

  it("echo with single-quoted redirect writes file", async () => {
    const { run, fs } = setup();
    await run("echo 'test content' > /f.txt");
    expect((await fs.readFile("/f.txt")).content).toBe("test content\n");
  });

  it("echo redirect without quotes writes file", async () => {
    const { run, fs } = setup();
    await run("echo stuff > /f.txt");
    expect((await fs.readFile("/f.txt")).content).toBe("stuff\n");
  });

  it("echo redirect overwrites existing file", async () => {
    const { run, fs } = setup({ "f.txt": "old" });
    await run('echo "new" > /f.txt');
    expect((await fs.readFile("/f.txt")).content).toBe("new\n");
  });

  it("echo redirect returns empty string", async () => {
    const { run } = setup();
    expect(await run('echo "x" > /f.txt')).toBe("");
  });

  it("echo preserves quoted strings", async () => {
    const { run } = setup();
    expect(await run('echo "hello world"')).toBe("hello world");
  });
});

// ─── wc ────────────────────────────────────────────────────

describe("wc", () => {
  it("shows lines words bytes by default", async () => {
    const { run } = setup({ "f.txt": "hello world\nfoo bar\n" });
    const result = await run("wc /f.txt");
    expect(result).toContain("f.txt");
    // Should have three numbers
    expect(result.trim().split(/\s+/).length).toBeGreaterThanOrEqual(4); // lines, words, bytes, filename
  });

  it("wc -l shows only line count", async () => {
    const { run } = setup({ "f.txt": "a\nb\nc" });
    const result = await run("wc -l /f.txt");
    expect(result).toContain("f.txt");
    expect(result).toMatch(/3/);
  });

  it("wc -w shows only word count", async () => {
    const { run } = setup({ "f.txt": "one two three" });
    const result = await run("wc -w /f.txt");
    expect(result).toContain("f.txt");
    expect(result).toMatch(/3/);
  });

  it("wc -c shows only byte count", async () => {
    const { run } = setup({ "f.txt": "hello" });
    const result = await run("wc -c /f.txt");
    expect(result).toContain("f.txt");
    expect(result).toMatch(/5/);
  });

  it("wc on empty file", async () => {
    const { run } = setup({ "f.txt": "" });
    const result = await run("wc /f.txt");
    expect(result).toContain("f.txt");
  });

  it("wc multiple files", async () => {
    const { run } = setup({
      "a.txt": "hello",
      "b.txt": "world",
    });
    const result = await run("wc /a.txt /b.txt");
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
    expect(result.split("\n")).toHaveLength(2);
  });

  it("wc no args returns error", async () => {
    const { run } = setup();
    expect(await run("wc")).toContain("missing operand");
  });

  it("wc missing file returns error", async () => {
    const { run } = setup();
    const result = await run("wc /nope.txt");
    expect(result).toContain("Not found");
  });
});

// ─── find ──────────────────────────────────────────────────

describe("find", () => {
  it("finds all files recursively", async () => {
    const { run } = setup({
      "src/a.txt": "a",
      "src/sub/b.txt": "b",
    });
    const result = await run("find /src");
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
    expect(result).toContain("sub");
  });

  it("find with -name glob pattern", async () => {
    const { run } = setup({
      "src/index.ts": "x",
      "src/utils.ts": "y",
      "src/style.css": "z",
    });
    const result = await run("find /src -name *.ts");
    expect(result).toContain("index.ts");
    expect(result).toContain("utils.ts");
    expect(result).not.toContain("style.css");
  });

  it("find with ? glob pattern", async () => {
    const { run } = setup({
      "src/a.ts": "x",
      "src/ab.ts": "y",
    });
    const result = await run("find /src -name ?.ts");
    expect(result).toContain("a.ts");
    expect(result).not.toContain("ab.ts");
  });

  it("find from cwd with .", async () => {
    const { run, fs } = setup({ "workspace/f.txt": "x" });
    fs.cd("/workspace");
    const result = await run("find .");
    expect(result).toContain("f.txt");
  });

  it("find with no matches returns empty", async () => {
    const { run } = setup({ "src/a.txt": "x" });
    const result = await run("find /src -name *.xyz");
    expect(result).toBe("");
  });

  it("find deeply nested", async () => {
    const { run } = setup({
      "a/b/c/d.txt": "deep",
    });
    const result = await run("find /a");
    expect(result).toContain("d.txt");
  });

  it("find default path is .", async () => {
    const { run, fs } = setup({ "f.txt": "x" });
    const result = await run("find -name *.txt");
    expect(result).toContain("f.txt");
  });
});

// ─── grep ──────────────────────────────────────────────────

describe("grep", () => {
  it("searches for pattern in single file", async () => {
    const { run } = setup({
      "f.txt": "hello world\nfoo bar\nhello again",
    });
    const result = await run("grep hello /f.txt");
    expect(result).toContain("hello world");
    expect(result).toContain("hello again");
    expect(result).not.toContain("foo bar");
  });

  it("single file has no filename prefix", async () => {
    const { run } = setup({ "f.txt": "match" });
    const result = await run("grep match /f.txt");
    expect(result).toBe("match");
    expect(result).not.toContain(":");
  });

  it("grep no match returns empty", async () => {
    const { run } = setup({ "f.txt": "hello" });
    expect(await run("grep xyz /f.txt")).toBe("");
  });

  it("grep -n shows line numbers", async () => {
    const { run } = setup({ "f.txt": "aaa\nbbb\naaa" });
    const result = await run("grep -n aaa /f.txt");
    expect(result).toContain("1:aaa");
    expect(result).toContain("3:aaa");
  });

  it("grep -i case insensitive", async () => {
    const { run } = setup({ "f.txt": "Hello\nhello\nHELLO" });
    const result = await run("grep -i hello /f.txt");
    expect(result.split("\n")).toHaveLength(3);
  });

  it("grep -r recursive search", async () => {
    const { run } = setup({
      "src/a.ts": "import foo",
      "src/b.ts": "import bar",
      "src/c.ts": "const x = 1",
    });
    const result = await run("grep -r import /src");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).not.toContain("c.ts");
  });

  it("grep -rn combined flags", async () => {
    const { run } = setup({
      "src/a.ts": "line1\nimport x\nline3",
    });
    const result = await run("grep -rn import /src");
    expect(result).toContain("a.ts:");
    expect(result).toContain("2:");
  });

  it("grep -ri case insensitive recursive", async () => {
    const { run } = setup({
      "src/a.ts": "Import foo",
      "src/b.ts": "IMPORT bar",
    });
    const result = await run("grep -ri import /src");
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });

  it("grep multiple files shows filename prefix", async () => {
    const { run } = setup({
      "a.txt": "match here",
      "b.txt": "no luck",
      "c.txt": "match too",
    });
    const result = await run("grep match /a.txt /b.txt /c.txt");
    expect(result).toContain("/a.txt:");
    expect(result).toContain("/c.txt:");
    expect(result).not.toContain("/b.txt:");
  });

  it("grep with regex pattern", async () => {
    const { run } = setup({ "f.txt": "foo123\nbar456\nbaz" });
    const result = await run("grep [0-9]+ /f.txt");
    expect(result).toContain("foo123");
    expect(result).toContain("bar456");
    expect(result).not.toContain("baz");
  });

  it("grep -r defaults to cwd", async () => {
    const { run, fs } = setup({
      "src/a.ts": "target line",
    });
    fs.cd("/src");
    const result = await run("grep -r target");
    expect(result).toContain("target line");
  });

  it("grep no pattern returns error", async () => {
    const { run } = setup();
    expect(await run("grep")).toContain("missing pattern");
  });

  it("grep pattern but no file returns error", async () => {
    const { run } = setup();
    expect(await run("grep pattern")).toContain("missing file");
  });
});

// ─── tree ──────────────────────────────────────────────────

describe("tree", () => {
  it("shows tree structure with connectors", async () => {
    const { run } = setup({
      "src/index.ts": "x",
      "src/utils.ts": "y",
    });
    const result = await run("tree /src");
    expect(result).toContain("/src");
    expect(result).toContain("├──");
    expect(result).toContain("└──");
  });

  it("shows directories with trailing /", async () => {
    const { run } = setup({
      "src/components/header.tsx": "x",
    });
    const result = await run("tree /src");
    expect(result).toContain("components/");
  });

  it("shows summary line", async () => {
    const { run } = setup({
      "src/a.ts": "x",
      "src/b.ts": "y",
      "src/sub/c.ts": "z",
    });
    const result = await run("tree /src");
    expect(result).toMatch(/1 directories?, 3 files/);
  });

  it("tree with no args uses cwd", async () => {
    const { run, fs } = setup({ "d/f.txt": "x" });
    fs.cd("/d");
    const result = await run("tree");
    expect(result).toContain(".");
    expect(result).toContain("f.txt");
  });

  it("tree empty dir shows 0 files", async () => {
    const { run } = setup({ "d/.keep": "" });
    const result = await run("tree /d");
    expect(result).toContain("0 directories, 0 files");
  });

  it("tree uses │ for nesting", async () => {
    const { run } = setup({
      "src/a/x.ts": "x",
      "src/b/y.ts": "y",
    });
    const result = await run("tree /src");
    expect(result).toContain("│");
  });

  it("tree nested structure", async () => {
    const { run } = setup({
      "src/components/ui/button.tsx": "x",
      "src/components/ui/input.tsx": "y",
      "src/components/header.tsx": "z",
      "src/index.ts": "w",
    });
    const result = await run("tree /src");
    expect(result).toContain("components/");
    expect(result).toContain("ui/");
    expect(result).toContain("button.tsx");
    expect(result).toContain("input.tsx");
    expect(result).toContain("header.tsx");
    expect(result).toContain("index.ts");
  });
});

// ─── command chaining ──────────────────────────────────────

describe("command chaining", () => {
  it("&& chains commands sequentially", async () => {
    const { run, fs } = setup();
    await run("mkdir /d && touch /d/f.txt");
    expect(await fs.exists("/d/f.txt")).toBe(true);
  });

  it("&& stops on first error", async () => {
    const { run, fs } = setup();
    const result = await run("cat /nope && touch /should-not-exist.txt");
    expect(result).toContain("Not found");
    expect(await fs.exists("/should-not-exist.txt")).toBe(false);
  });

  it("&& chains more than two commands", async () => {
    const { run, fs } = setup();
    await run("mkdir /a && mkdir /b && mkdir /c");
    expect(await fs.exists("/a")).toBe(true);
    expect(await fs.exists("/b")).toBe(true);
    expect(await fs.exists("/c")).toBe(true);
  });

  it("; chains commands regardless of failure", async () => {
    const { run, fs } = setup();
    await run("touch /a.txt; touch /b.txt");
    expect(await fs.exists("/a.txt")).toBe(true);
    expect(await fs.exists("/b.txt")).toBe(true);
  });

  it("; continues after error", async () => {
    const { run, fs } = setup();
    await run("cat /nope; touch /still-created.txt");
    expect(await fs.exists("/still-created.txt")).toBe(true);
  });

  it("; does not split inside quotes", async () => {
    const { run } = setup();
    // semicolons in quoted strings should not split
    const result = await run('echo "hello; world"');
    expect(result).toBe("hello; world");
  });
});

// ─── unknown commands ──────────────────────────────────────

describe("unknown commands", () => {
  it("npm: command not found", async () => {
    const { run } = setup();
    expect(await run("npm install")).toBe("npm: command not found");
  });

  it("node: command not found", async () => {
    const { run } = setup();
    expect(await run("node -v")).toBe("node: command not found");
  });

  it("python3: command not found", async () => {
    const { run } = setup();
    expect(await run("python3 script.py")).toBe("python3: command not found");
  });

  it("git: command not found", async () => {
    const { run } = setup();
    expect(await run("git status")).toBe("git: command not found");
  });

  it("curl: command not found", async () => {
    const { run } = setup();
    expect(await run("curl https://example.com")).toBe("curl: command not found");
  });

  it("docker: command not found", async () => {
    const { run } = setup();
    expect(await run("docker ps")).toBe("docker: command not found");
  });

  it("pip: command not found", async () => {
    const { run } = setup();
    expect(await run("pip install foo")).toBe("pip: command not found");
  });

  it("uses the actual command name in error", async () => {
    const { run } = setup();
    const result = await run("rustc --version");
    expect(result).toBe("rustc: command not found");
  });
});

// ─── special commands ──────────────────────────────────────

describe("special commands", () => {
  it("whoami returns user", async () => {
    const { run } = setup();
    expect(await run("whoami")).toBe("user");
  });

  it("which returns /usr/bin/<cmd>", async () => {
    const { run } = setup();
    expect(await run("which ls")).toBe("/usr/bin/ls");
    expect(await run("which cat")).toBe("/usr/bin/cat");
    expect(await run("which grep")).toBe("/usr/bin/grep");
  });

  it("which with no args returns empty", async () => {
    const { run } = setup();
    expect(await run("which")).toBe("");
  });

  it("true returns empty", async () => {
    const { run } = setup();
    expect(await run("true")).toBe("");
  });

  it("false returns empty", async () => {
    const { run } = setup();
    expect(await run("false")).toBe("");
  });
});

// ─── tokenizer / quoting ───────────────────────────────────

describe("tokenizer and quoting", () => {
  it("double quotes preserve spaces", async () => {
    const { run } = setup();
    expect(await run('echo "hello world"')).toBe("hello world");
  });

  it("single quotes preserve spaces", async () => {
    const { run } = setup();
    expect(await run("echo 'hello world'")).toBe("hello world");
  });

  it("single quotes inside double quotes", async () => {
    const { run } = setup();
    expect(await run(`echo "it's working"`)).toBe("it's working");
  });

  it("double quotes inside single quotes", async () => {
    const { run } = setup();
    expect(await run(`echo 'say "hello"'`)).toBe('say "hello"');
  });

  it("multiple spaces between args collapsed", async () => {
    const { run } = setup();
    // Extra spaces between tokens should be collapsed by tokenizer
    const result = await run("echo   hello    world");
    expect(result).toBe("hello world");
  });

  it("handles leading/trailing whitespace", async () => {
    const { run } = setup();
    expect(await run("   echo test   ")).toBe("test");
  });
});

// ─── edge cases and security ───────────────────────────────

describe("edge cases and security", () => {
  it("empty command returns empty", async () => {
    const { run } = setup();
    expect(await run("")).toBe("");
  });

  it("whitespace-only command returns empty", async () => {
    const { run } = setup();
    expect(await run("   ")).toBe("");
  });

  it("commands work with prefix (sandboxed)", async () => {
    const { run, fs } = setup({ "sandbox/f.txt": "data" }, { prefix: "sandbox" });
    expect(await run("cat /f.txt")).toBe("data");
  });

  it("ls does not show .keep sentinels", async () => {
    const { run } = setup({
      "dir/.keep": "",
      "dir/real.txt": "x",
    });
    const result = await run("ls /dir");
    expect(result).not.toContain(".keep");
  });

  it("find does not show .keep sentinels in results", async () => {
    // find uses listDir which filters .keep
    const { run } = setup({
      "dir/.keep": "",
      "dir/real.txt": "x",
    });
    const result = await run("find /dir");
    expect(result).not.toContain(".keep");
  });

  it("never returns S3 errors to model", async () => {
    const store = new MemoryStore();
    const fs = new Filesystem({ bucket: "b", client: store as any });
    const shell = getShellTool(fs);
    const result = await shell.execute({ command: "cat /nope" });
    expect(result).not.toContain("S3");
    expect(result).not.toContain("bucket");
    expect(result).not.toContain("NoSuchKey");
  });

  it("all commands return strings, never throw", async () => {
    const { run } = setup();
    // All of these should return strings, not throw
    const results = await Promise.all([
      run("cat /nope"),
      run("head /nope"),
      run("tail /nope"),
      run("wc /nope"),
      run("cp /nope /dest"),
      run("mv /nope /dest"),
      run("grep pattern /nope"),
    ]);
    for (const r of results) {
      expect(typeof r).toBe("string");
    }
  });

  it("cd + ls workflow", async () => {
    const { run } = setup({
      "src/components/button.tsx": "export function Button() {}",
      "src/components/header.tsx": "export function Header() {}",
      "src/index.ts": "import stuff",
    });
    await run("cd /src");
    expect(await run("pwd")).toBe("/src");
    const ls1 = await run("ls");
    expect(ls1).toContain("components/");
    expect(ls1).toContain("index.ts");

    await run("cd components");
    expect(await run("pwd")).toBe("/src/components");
    const ls2 = await run("ls");
    expect(ls2).toContain("button.tsx");
    expect(ls2).toContain("header.tsx");
  });

  it("full workflow: mkdir, echo, cat, grep, rm", async () => {
    const { run, fs } = setup();
    await run("mkdir /project");
    await run('echo "hello world" > /project/readme.txt');
    await run('echo "goodbye world" > /project/notes.txt');

    expect(await run("cat /project/readme.txt")).toBe("hello world\n");

    const grep = await run("grep -r world /project");
    expect(grep).toContain("readme.txt");
    expect(grep).toContain("notes.txt");

    const ls = await run("ls /project");
    expect(ls).toContain("readme.txt");
    expect(ls).toContain("notes.txt");

    await run("rm -rf /project");
    expect(await fs.exists("/project")).toBe(false);
  });
});

// ─── PIPES ─────────────────────────────────────────────────

describe("pipes", () => {
  it("cat | head pipes content", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { run } = setup({ "f.txt": content });
    const result = await run("cat /f.txt | head -n 3");
    expect(result.split("\n")).toHaveLength(3);
    expect(result).toContain("line 1");
  });

  it("cat | tail pipes content", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { run } = setup({ "f.txt": content });
    const result = await run("cat /f.txt | tail -n 3");
    expect(result.split("\n")).toHaveLength(3);
    expect(result).toContain("line 20");
  });

  it("cat | head | tail multi-pipe", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const { run } = setup({ "f.txt": content });
    const result = await run("cat /f.txt | head -n 10 | tail -n 3");
    expect(result.split("\n")).toHaveLength(3);
    expect(result).toContain("line 8");
    expect(result).toContain("line 10");
  });

  it("cat | grep filters content", async () => {
    const { run } = setup({ "f.txt": "apple\nbanana\napricot\ncherry" });
    const result = await run("cat /f.txt | grep ap");
    expect(result).toContain("apple");
    expect(result).toContain("apricot");
    expect(result).not.toContain("banana");
  });

  it("cat | grep -n from stdin shows line numbers", async () => {
    const { run } = setup({ "f.txt": "aaa\nbbb\naaa" });
    const result = await run("cat /f.txt | grep -n aaa");
    expect(result).toContain("1:aaa");
    expect(result).toContain("3:aaa");
  });

  it("cat | wc -l counts lines from stdin", async () => {
    const { run } = setup({ "f.txt": "a\nb\nc" });
    const result = await run("cat /f.txt | wc -l");
    expect(result.trim()).toBe("3");
  });

  it("cat | sort sorts lines", async () => {
    const { run } = setup({ "f.txt": "cherry\napple\nbanana" });
    const result = await run("cat /f.txt | sort");
    expect(result).toBe("apple\nbanana\ncherry");
  });

  it("cat | sort -r reverse sorts", async () => {
    const { run } = setup({ "f.txt": "a\nc\nb" });
    const result = await run("cat /f.txt | sort -r");
    expect(result).toBe("c\nb\na");
  });

  it("cat | uniq deduplicates", async () => {
    const { run } = setup({ "f.txt": "a\na\nb\nb\nb\nc" });
    const result = await run("cat /f.txt | uniq");
    expect(result).toBe("a\nb\nc");
  });

  it("cat | uniq -c counts", async () => {
    const { run } = setup({ "f.txt": "a\na\nb\nc\nc\nc" });
    const result = await run("cat /f.txt | uniq -c");
    expect(result).toContain("2 a");
    expect(result).toContain("1 b");
    expect(result).toContain("3 c");
  });

  it("cat | sort | uniq chain", async () => {
    const { run } = setup({ "f.txt": "b\na\nb\na\nc" });
    const result = await run("cat /f.txt | sort | uniq");
    expect(result).toBe("a\nb\nc");
  });

  it("grep | wc -l counts matches", async () => {
    const { run } = setup({ "f.txt": "yes\nno\nyes\nno\nyes" });
    const result = await run("grep yes /f.txt | wc -l");
    expect(result.trim()).toBe("3");
  });

  it("pipe output to file with redirect", async () => {
    const { run, fs } = setup({ "f.txt": "cherry\napple\nbanana" });
    await run("cat /f.txt | sort > /sorted.txt");
    const { content } = await fs.readFile("/sorted.txt");
    expect(content).toBe("apple\nbanana\ncherry\n");
  });
});

// ─── HEREDOC ───────────────────────────────────────────────

describe("heredoc", () => {
  it("cat > file << EOF writes multi-line content", async () => {
    const { run, fs } = setup();
    await run("cat > /f.txt << EOF\nline 1\nline 2\nline 3\nEOF");
    const { content } = await fs.readFile("/f.txt");
    expect(content).toBe("line 1\nline 2\nline 3\n");
  });

  it("cat > file << 'EOF' with quoted delimiter", async () => {
    const { run, fs } = setup();
    await run("cat > /f.txt << 'EOF'\nhello world\nfoo bar\nEOF");
    const { content } = await fs.readFile("/f.txt");
    expect(content).toBe("hello world\nfoo bar\n");
  });

  it("cat << EOF > file alternate syntax", async () => {
    const { run, fs } = setup();
    await run("cat << EOF > /f.txt\ncontent here\nEOF");
    const { content } = await fs.readFile("/f.txt");
    expect(content).toBe("content here\n");
  });

  it("heredoc with code content", async () => {
    const { run, fs } = setup();
    await run('cat > /app.tsx << EOF\nexport function App() {\n  return <h1>Hello</h1>;\n}\nEOF');
    const { content } = await fs.readFile("/app.tsx");
    expect(content).toContain("export function App()");
    expect(content).toContain("<h1>Hello</h1>");
  });
});

// ─── GREP -A/-B/-C ─────────────────────────────────────────

describe("grep context lines", () => {
  const content = "line 1\nline 2\nMATCH\nline 4\nline 5\nline 6\nMATCH2\nline 8";

  it("grep -A 2 shows lines after match", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("grep -A 2 MATCH /f.txt");
    expect(result).toContain("MATCH");
    expect(result).toContain("line 4");
    expect(result).toContain("line 5");
  });

  it("grep -B 2 shows lines before match", async () => {
    const { run } = setup({ "f.txt": content });
    const result = await run("grep -B 2 MATCH2 /f.txt");
    expect(result).toContain("line 5");
    expect(result).toContain("line 6");
    expect(result).toContain("MATCH2");
  });

  it("grep -C 1 shows context around match", async () => {
    const { run } = setup({ "f.txt": "a\nb\nTARGET\nd\ne" });
    const result = await run("grep -C 1 TARGET /f.txt");
    expect(result).toContain("b");
    expect(result).toContain("TARGET");
    expect(result).toContain("d");
    expect(result).not.toContain("a");
    expect(result).not.toContain("e");
  });

  it("grep -A from stdin via pipe", async () => {
    const { run } = setup({ "f.txt": "a\nb\nMATCH\nd\ne" });
    const result = await run("cat /f.txt | grep -A 1 MATCH");
    expect(result).toContain("MATCH");
    expect(result).toContain("d");
    expect(result).not.toContain("b");
  });

  it("grep -A with -n shows line numbers in context", async () => {
    const { run } = setup({ "f.txt": "a\nb\nMATCH\nd" });
    const result = await run("grep -n -A 1 MATCH /f.txt");
    expect(result).toContain("3:MATCH");
    expect(result).toContain("4:d");
  });
});

// ─── SED ───────────────────────────────────────────────────

describe("sed", () => {
  it("sed s/old/new/ replaces first occurrence per line", async () => {
    const { run } = setup({ "f.txt": "hello world hello" });
    const result = await run("sed s/hello/hi/ /f.txt");
    expect(result).toBe("hi world hello");
  });

  it("sed s/old/new/g replaces all occurrences", async () => {
    const { run } = setup({ "f.txt": "hello world hello" });
    const result = await run("sed s/hello/hi/g /f.txt");
    expect(result).toBe("hi world hi");
  });

  it("sed -i modifies file in place", async () => {
    const { run, fs } = setup({ "f.txt": "price: $29" });
    await run("sed -i s/29/49/g /f.txt");
    const { content } = await fs.readFile("/f.txt");
    expect(content).toBe("price: $49");
  });

  it("sed with pipe from stdin", async () => {
    const { run } = setup({ "f.txt": "foo bar baz" });
    const result = await run("cat /f.txt | sed s/bar/qux/");
    expect(result).toBe("foo qux baz");
  });

  it("sed with different delimiter", async () => {
    const { run } = setup({ "f.txt": "/usr/local/bin" });
    const result = await run("sed s|/usr/local|/opt| /f.txt");
    expect(result).toBe("/opt/bin");
  });

  it("sed multiline file processes each line", async () => {
    const { run } = setup({ "f.txt": "aaa\nbbb\naaa" });
    const result = await run("sed s/aaa/xxx/ /f.txt");
    expect(result).toBe("xxx\nbbb\nxxx");
  });

  it("sed -e flag for expression", async () => {
    const { run } = setup({ "f.txt": "hello" });
    const result = await run("sed -e s/hello/goodbye/ /f.txt");
    expect(result).toBe("goodbye");
  });

  it("sed missing expression returns error", async () => {
    const { run } = setup();
    expect(await run("sed /f.txt")).toContain("missing expression");
  });
});

// ─── DIFF ──────────────────────────────────────────────────

describe("diff", () => {
  it("diff identical files returns empty", async () => {
    const { run } = setup({ "a.txt": "same", "b.txt": "same" });
    expect(await run("diff /a.txt /b.txt")).toBe("");
  });

  it("diff different files shows changes", async () => {
    const { run } = setup({ "a.txt": "hello\nworld", "b.txt": "hello\nearth" });
    const result = await run("diff /a.txt /b.txt");
    expect(result).toContain("--- /a.txt");
    expect(result).toContain("+++ /b.txt");
    expect(result).toContain("-world");
    expect(result).toContain("+earth");
  });

  it("diff shows added lines", async () => {
    const { run } = setup({ "a.txt": "line1", "b.txt": "line1\nline2" });
    const result = await run("diff /a.txt /b.txt");
    expect(result).toContain("+line2");
  });

  it("diff shows removed lines", async () => {
    const { run } = setup({ "a.txt": "line1\nline2", "b.txt": "line1" });
    const result = await run("diff /a.txt /b.txt");
    expect(result).toContain("-line2");
  });

  it("diff missing operand returns error", async () => {
    const { run } = setup();
    expect(await run("diff")).toContain("missing operand");
    expect(await run("diff /a")).toContain("missing operand");
  });
});

// ─── SORT ──────────────────────────────────────────────────

describe("sort", () => {
  it("sort from stdin", async () => {
    const { run } = setup({ "f.txt": "cherry\napple\nbanana" });
    expect(await run("cat /f.txt | sort")).toBe("apple\nbanana\ncherry");
  });

  it("sort -r reverses", async () => {
    const { run } = setup({ "f.txt": "a\nc\nb" });
    expect(await run("cat /f.txt | sort -r")).toBe("c\nb\na");
  });

  it("sort -n numeric sort", async () => {
    const { run } = setup({ "f.txt": "10\n2\n30\n1" });
    expect(await run("cat /f.txt | sort -n")).toBe("1\n2\n10\n30");
  });

  it("sort -u removes duplicates", async () => {
    const { run } = setup({ "f.txt": "b\na\nb\na" });
    expect(await run("cat /f.txt | sort -u")).toBe("a\nb");
  });
});

// ─── UNIQ ──────────────────────────────────────────────────

describe("uniq", () => {
  it("removes consecutive duplicates", async () => {
    const { run } = setup({ "f.txt": "a\na\nb\nb\nc" });
    expect(await run("cat /f.txt | uniq")).toBe("a\nb\nc");
  });

  it("uniq -c shows counts", async () => {
    const { run } = setup({ "f.txt": "x\nx\nx\ny" });
    const result = await run("cat /f.txt | uniq -c");
    expect(result).toContain("3 x");
    expect(result).toContain("1 y");
  });
});

// ─── TEE ───────────────────────────────────────────────────

describe("tee", () => {
  it("tee writes stdin to file and passes through", async () => {
    const { run, fs } = setup({ "f.txt": "data" });
    const result = await run("cat /f.txt | tee /copy.txt");
    expect(result).toBe("data");
    expect((await fs.readFile("/copy.txt")).content).toBe("data");
  });
});

// ─── BASENAME / DIRNAME ────────────────────────────────────

describe("basename / dirname", () => {
  it("basename extracts filename", async () => {
    const { run } = setup();
    expect(await run("basename /path/to/file.txt")).toBe("file.txt");
  });

  it("dirname extracts directory", async () => {
    const { run } = setup();
    expect(await run("dirname /path/to/file.txt")).toBe("/path/to");
  });

  it("dirname of root-level file returns /", async () => {
    const { run } = setup();
    expect(await run("dirname /file.txt")).toBe("/");
  });
});

// ─── redirect from any command ─────────────────────────────

describe("output redirect", () => {
  it("grep > file captures output", async () => {
    const { run, fs } = setup({ "f.txt": "apple\nbanana\napricot" });
    await run("grep ap /f.txt > /matches.txt");
    const { content } = await fs.readFile("/matches.txt");
    expect(content).toContain("apple");
    expect(content).toContain("apricot");
    expect(content).not.toContain("banana");
  });

  it("ls > file captures listing", async () => {
    const { run, fs } = setup({ "a.txt": "a", "b.txt": "b" });
    await run("ls / > /listing.txt");
    const { content } = await fs.readFile("/listing.txt");
    expect(content).toContain("a.txt");
    expect(content).toContain("b.txt");
  });

  it("find > file captures results", async () => {
    const { run, fs } = setup({ "src/a.ts": "x", "src/b.ts": "y" });
    await run("find /src -name *.ts > /files.txt");
    const { content } = await fs.readFile("/files.txt");
    expect(content).toContain("a.ts");
    expect(content).toContain("b.ts");
  });
});
