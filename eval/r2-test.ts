/**
 * Integration test against a real Cloudflare R2 bucket.
 * Seeds files, runs filesystem operations, verifies results, cleans up.
 *
 * Usage: npx tsx eval/r2-test.ts
 *
 * Requires env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { Filesystem, getTools, getShellTool } from "../src/index.js";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const BUCKET = process.env.R2_BUCKET!;
const PREFIX = `s3fs-test-${Date.now()}`;

const fs = new Filesystem({
  bucket: BUCKET,
  prefix: PREFIX,
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  region: "auto",
});

let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name: string, err: unknown) {
  failed++;
  console.log(`  ✗ ${name}: ${err}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ─── tests ─────────────────────────────────────────────────

async function main() {
  console.log(`\nR2 integration test`);
  console.log(`  Bucket: ${BUCKET}`);
  console.log(`  Prefix: ${PREFIX}`);
  console.log(`  Endpoint: https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
  console.log();

  // ── writeFile + readFile ──

  await test("writeFile creates a file", async () => {
    const result = await fs.writeFile("/hello.txt", "Hello from s3fs-agent!");
    assert(!!result.etag, "should return etag");
  });

  await test("readFile reads the file back", async () => {
    const result = await fs.readFile("/hello.txt");
    assert(result.content === "Hello from s3fs-agent!", `content mismatch: ${result.content}`);
    assert(!!result.etag, "should have etag");
    assert(result.size > 0, "should have size");
    assert(result.lastModified instanceof Date, "should have lastModified");
  });

  // ── exists ──

  await test("exists returns true for existing file", async () => {
    assert(await fs.exists("/hello.txt") === true, "should exist");
  });

  await test("exists returns false for missing file", async () => {
    assert(await fs.exists("/nonexistent.txt") === false, "should not exist");
  });

  // ── conditional write (optimistic locking) ──

  await test("conditional write succeeds with matching etag", async () => {
    const { etag } = await fs.readFile("/hello.txt");
    const result = await fs.writeFile("/hello.txt", "Updated content", { ifMatch: etag });
    assert(!!result.etag, "should return new etag");
    const { content } = await fs.readFile("/hello.txt");
    assert(content === "Updated content", "content should be updated");
  });

  await test("conditional write fails with stale etag", async () => {
    try {
      await fs.writeFile("/hello.txt", "Should fail", { ifMatch: "stale-etag" });
      throw new Error("should have thrown ConflictError");
    } catch (err: any) {
      assert(err.code === "CONFLICT", `expected CONFLICT, got ${err.code}`);
    }
  });

  // ── mkdir + listDir ──

  await test("mkdir creates a directory", async () => {
    await fs.mkdir("/testdir");
    assert(await fs.exists("/testdir") === true, "directory should exist");
  });

  await test("write files into directory", async () => {
    await fs.writeFile("/testdir/a.txt", "file a");
    await fs.writeFile("/testdir/b.txt", "file b");
  });

  await test("listDir shows files and filters .keep", async () => {
    const entries = await fs.listDir("/testdir");
    const names = entries.map((e) => e.name).sort();
    assert(names.includes("a.txt"), "should list a.txt");
    assert(names.includes("b.txt"), "should list b.txt");
    assert(!names.includes(".keep"), "should filter .keep");
  });

  // ── nested directory listing ──

  await test("mkdir nested + listDir shows subdirectory", async () => {
    await fs.mkdir("/testdir/sub");
    await fs.writeFile("/testdir/sub/c.txt", "file c");
    const entries = await fs.listDir("/testdir");
    const dirs = entries.filter((e) => e.type === "directory");
    assert(dirs.some((d) => d.name === "sub"), "should show sub directory");
  });

  // ── move ──

  await test("move renames a file", async () => {
    await fs.writeFile("/moveme.txt", "move this");
    await fs.move("/moveme.txt", "/moved.txt");
    assert(await fs.exists("/moveme.txt") === false, "source should be gone");
    const { content } = await fs.readFile("/moved.txt");
    assert(content === "move this", "content should be preserved");
  });

  // ── deleteFile ──

  await test("deleteFile removes a file", async () => {
    await fs.deleteFile("/moved.txt");
    assert(await fs.exists("/moved.txt") === false, "should be deleted");
  });

  // ── rmdir ──

  await test("rmdir fails on non-empty directory", async () => {
    try {
      await fs.rmdir("/testdir");
      throw new Error("should have thrown");
    } catch (err: any) {
      assert(err.code === "DIR_NOT_EMPTY", `expected DIR_NOT_EMPTY, got ${err.code}`);
    }
  });

  await test("rmdir recursive cleans up", async () => {
    await fs.rmdir("/testdir", true);
    const entries = await fs.listDir("/testdir");
    assert(entries.length === 0, "directory should be empty");
  });

  // ── cd + cwd ──

  await test("cd changes working directory", async () => {
    fs.cd("/workspace");
    assert(fs.cwd === "/workspace", `cwd should be /workspace, got ${fs.cwd}`);
    fs.cd("/");
  });

  // ── tools work over R2 ──

  await test("getTools() works over R2", async () => {
    const tools = getTools(fs);
    const writeTool = tools.find((t) => t.name === "write_file")!;
    const readTool = tools.find((t) => t.name === "read_file")!;
    const listTool = tools.find((t) => t.name === "list_directory")!;

    const writeResult = await writeTool.execute({ path: "/tools-test.txt", content: "via tools" });
    assert(writeResult === "File written successfully.", `unexpected: ${writeResult}`);

    const readResult = await readTool.execute({ path: "/tools-test.txt" });
    assert(readResult === "via tools", `unexpected: ${readResult}`);

    await fs.deleteFile("/tools-test.txt");
  });

  // ── shell tool works over R2 ──

  await test("shell tool works over R2", async () => {
    const shell = getShellTool(fs);

    await shell.execute({ command: "mkdir /shelltest" });
    await shell.execute({ command: 'echo "shell content" > /shelltest/file.txt' });

    const cat = await shell.execute({ command: "cat /shelltest/file.txt" });
    assert(cat === "shell content\n", `unexpected cat: ${cat}`);

    const ls = await shell.execute({ command: "ls /shelltest" });
    assert(ls.includes("file.txt"), `ls should show file.txt: ${ls}`);

    const tree = await shell.execute({ command: "tree /shelltest" });
    assert(tree.includes("file.txt"), `tree should show file.txt`);

    await shell.execute({ command: "rm -rf /shelltest" });
  });

  // ── cleanup ──

  console.log("\n  Cleaning up test prefix...");
  await fs.deleteFile("/hello.txt");
  await fs.rmdir("/", true);
  console.log("  Done.\n");

  // ── summary ──

  console.log(`${"═".repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
