import { describe, it, expect } from "vitest";
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Filesystem } from "../src/filesystem.js";
import { getTools } from "../src/tools.js";
import { MemoryStore } from "./memory-store.js";
import { PROJECT_FILES } from "./seed.js";

function setup(files: Record<string, string> = {}) {
  const store = new MemoryStore();
  store.seed(files);
  const fs = new Filesystem({ bucket: "test", client: store as any });
  return { store, fs };
}

describe("MemoryStore", () => {
  it("seeds files and reads them back", async () => {
    const { fs } = setup({ "hello.txt": "world" });
    const result = await fs.readFile("/hello.txt");
    expect(result.content).toBe("world");
    expect(result.etag).toBeTruthy();
    expect(result.size).toBe(5);
  });

  it("writes and reads new files", async () => {
    const { fs } = setup();
    await fs.writeFile("/new.txt", "hello");
    const result = await fs.readFile("/new.txt");
    expect(result.content).toBe("hello");
  });

  it("overwrites existing files", async () => {
    const { fs } = setup({ "f.txt": "old" });
    await fs.writeFile("/f.txt", "new");
    const result = await fs.readFile("/f.txt");
    expect(result.content).toBe("new");
  });

  it("throws NotFound for missing files", async () => {
    const { fs } = setup();
    await expect(fs.readFile("/nope.txt")).rejects.toThrow("Not found");
  });

  it("deletes files", async () => {
    const { fs } = setup({ "f.txt": "data" });
    await fs.deleteFile("/f.txt");
    await expect(fs.readFile("/f.txt")).rejects.toThrow("Not found");
  });

  it("exists returns true/false correctly", async () => {
    const { fs } = setup({ "f.txt": "data" });
    expect(await fs.exists("/f.txt")).toBe(true);
    expect(await fs.exists("/nope.txt")).toBe(false);
  });

  it("lists directory contents", async () => {
    const { fs } = setup({
      "src/a.txt": "a",
      "src/b.txt": "b",
      "src/sub/c.txt": "c",
    });
    const entries = await fs.listDir("/src");
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    const dirs = entries.filter((e) => e.type === "directory");
    expect(dirs.map((d) => d.name)).toContain("sub");
  });

  it("mkdir + listDir shows directory", async () => {
    const { fs } = setup();
    await fs.mkdir("/mydir");
    expect(await fs.exists("/mydir")).toBe(true);
  });

  it("move renames files", async () => {
    const { fs } = setup({ "old.txt": "content" });
    await fs.move("/old.txt", "/new.txt");
    await expect(fs.readFile("/old.txt")).rejects.toThrow("Not found");
    const result = await fs.readFile("/new.txt");
    expect(result.content).toBe("content");
  });

  it("rmdir removes directory", async () => {
    const { fs, store } = setup();
    await fs.mkdir("/d");
    expect(store.has("d/.keep")).toBe(true);
    await fs.rmdir("/d");
    expect(store.has("d/.keep")).toBe(false);
  });

  it("conditional write fails on etag mismatch", async () => {
    const { fs } = setup({ "f.txt": "v1" });
    await expect(
      fs.writeFile("/f.txt", "v2", { ifMatch: "wrong-etag" }),
    ).rejects.toThrow("Conflict");
  });

  it("conditional write succeeds on etag match", async () => {
    const { fs } = setup({ "f.txt": "v1" });
    const { etag } = await fs.readFile("/f.txt");
    await fs.writeFile("/f.txt", "v2", { ifMatch: etag });
    const result = await fs.readFile("/f.txt");
    expect(result.content).toBe("v2");
  });
});

describe("MemoryStore with seed project", () => {
  it("seeds all project files", async () => {
    const { store } = setup(PROJECT_FILES);
    expect(store.keys().length).toBe(Object.keys(PROJECT_FILES).length);
  });

  it("can navigate the full project via tools", async () => {
    const { fs } = setup(PROJECT_FILES);
    const tools = getTools(fs);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // List root
    const root = await byName.list_directory.execute({ path: "/" });
    expect(root).toContain("package.json");
    expect(root).toContain("src/");

    // cd into src and list
    await byName.change_directory.execute({ path: "/src" });
    const src = await byName.list_directory.execute({});
    expect(src).toContain("app/");
    expect(src).toContain("components/");
    expect(src).toContain("lib/");

    // Read a file
    const page = await byName.read_file.execute({ path: "/src/app/page.tsx" });
    expect(page).toContain("Acme Dashboard");
    expect(page).toContain("Header");

    // Create a new file
    const writeResult = await byName.write_file.execute({
      path: "/src/components/button.tsx",
      content: 'export function Button() { return <button>Click</button>; }',
    });
    expect(writeResult).toBe("File written successfully.");

    // Verify it exists
    const exists = await byName.file_exists.execute({
      path: "/src/components/button.tsx",
    });
    expect(exists).toBe("true");

    // List components to see it
    const components = await byName.list_directory.execute({
      path: "/src/components",
    });
    expect(components).toContain("button.tsx");
    expect(components).toContain("header.tsx");
    expect(components).toContain("footer.tsx");
  });
});
