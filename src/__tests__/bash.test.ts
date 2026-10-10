import { describe, expect, it } from "vitest";
import { bashTool, ConflictError, createBash, KrinoFs, memoryStore, type ObjectStore } from "../index.js";

const text = (store: ReturnType<typeof memoryStore>, key: string) => {
  const obj = store.objects.get(key);
  return obj ? new TextDecoder().decode(obj.body) : undefined;
};

async function setup(seed: Record<string, string> = {}, prefix = "s/1") {
  const store = memoryStore();
  for (const [path, body] of Object.entries(seed)) {
    await store.put(`${prefix}/${path}`, new TextEncoder().encode(body));
  }
  const { bash, fs } = await createBash({ store, prefix });
  const run = async (cmd: string) => {
    const r = await bash.exec(cmd);
    return { ...r, out: r.stdout.trimEnd() };
  };
  return { store, bash, fs, run };
}

describe("shell over object storage", () => {
  it("starts in /workspace and sees stored files", async () => {
    const { run } = await setup({ "src/app.ts": "export const x = 1;\n", "README.md": "# hi\n" });
    expect((await run("pwd")).out).toBe("/workspace");
    expect((await run("ls")).out.split(/\s+/)).toEqual(["README.md", "src"]);
    expect((await run("cat src/app.ts")).out).toBe("export const x = 1;");
  });

  it("writes through redirects and heredocs to storage", async () => {
    const { run, store } = await setup();
    await run("echo hello > a.txt && echo world >> a.txt");
    await run("mkdir -p docs/notes && cat > docs/notes/n.md <<'EOF'\nline one\nline two\nEOF");
    expect(text(store, "s/1/a.txt")).toBe("hello\nworld\n");
    expect(text(store, "s/1/docs/notes/n.md")).toBe("line one\nline two\n");
  });

  it("runs pipes, grep, find, sed -i and wc", async () => {
    const { run, store } = await setup({
      "src/a.ts": "import x from 'x';\nconst price = 29;\n",
      "src/lib/b.ts": "import y from 'y';\n",
      "notes.txt": "nothing here\n",
    });
    expect((await run("grep -rn import src | sort")).out).toBe(
      "src/a.ts:1:import x from 'x';\nsrc/lib/b.ts:1:import y from 'y';",
    );
    expect((await run("find . -name '*.ts' | sort")).out).toBe("./src/a.ts\n./src/lib/b.ts");
    await run("sed -i 's/29/49/' src/a.ts");
    expect(text(store, "s/1/src/a.ts")).toContain("price = 49");
    expect((await run("cat src/*.ts src/lib/*.ts | wc -l")).out.trim()).toBe("3");
  });

  it("supports cd within one command and keeps a real-looking tree", async () => {
    const { run } = await setup({ "a/b/c.txt": "deep\n" });
    expect((await run("cd a/b && cat c.txt && pwd")).out).toBe("deep\n/workspace/a/b");
    expect((await run("cd ../../../.. && pwd")).out).toBe("/");
  });

  it("moves, copies and removes files and folders in storage", async () => {
    const { run, store } = await setup({ "src/a.ts": "a\n", "src/sub/b.ts": "b\n" });
    await run("cp -r src backup");
    expect(text(store, "s/1/backup/sub/b.ts")).toBe("b\n");
    await run("mv src lib");
    expect(text(store, "s/1/src/a.ts")).toBeUndefined();
    expect(text(store, "s/1/lib/sub/b.ts")).toBe("b\n");
    await run("rm -rf backup");
    expect([...store.objects.keys()].some((k) => k.startsWith("s/1/backup"))).toBe(false);
    expect((await run("ls")).out).toBe("lib");
  });

  it("keeps empty folders across sessions without showing the marker", async () => {
    const store = memoryStore();
    const first = await createBash({ store, prefix: "p" });
    await first.bash.exec("mkdir -p empty/inside && echo x > f/../keep.txt");
    await first.bash.exec("mkdir tmpdir && touch tmpdir/x && rm tmpdir/x");

    const second = await createBash({ store, prefix: "p" });
    const ls = await second.bash.exec("ls -a empty tmpdir; find . | sort");
    expect(ls.stdout).toContain("inside");
    expect(ls.stdout).not.toContain(".krino-dir");
    expect((await second.bash.exec("test -d tmpdir && echo yes")).stdout).toBe("yes\n");
  });

  it("isolates prefixes and clamps traversal at the mount", async () => {
    const store = memoryStore();
    await store.put("other/secret.txt", new TextEncoder().encode("nope"));
    const { bash } = await createBash({ store, prefix: "mine" });
    const r = await bash.exec("cat ../other/secret.txt; cat ../../other/secret.txt; ls /");
    expect(r.stdout).not.toContain("nope");
    await bash.exec("echo hi > ../../escape.txt");
    expect(store.objects.has("escape.txt")).toBe(false);
  });

  it("keeps /tmp and /dev in memory, not in storage", async () => {
    const { run, store } = await setup();
    await run("echo scratch > /tmp/x && echo gone > /dev/null");
    expect((await run("cat /tmp/x")).out).toBe("scratch");
    expect(store.objects.size).toBe(0);
  });

  it("gives the agent shell errors, never storage details", async () => {
    const failing: ObjectStore = {
      ...memoryStore(),
      async get() {
        throw new Error("S3 AccessDenied bucket=prod-agents key=s/1/x.txt");
      },
    };
    await failing.put("s/1/x.txt", new Uint8Array([104]));
    const { bash } = await createBash({ store: failing, prefix: "s/1" });
    const r = await bash.exec("cat x.txt; cat missing.txt");
    expect(r.stderr).not.toMatch(/S3|bucket|prod-agents|AccessDenied/);
    expect(r.stderr).toContain("missing.txt");
  });
});

describe("KrinoFs", () => {
  it("serves stat and readdir without touching storage after open", async () => {
    const store = memoryStore();
    await store.put("a/b.txt", new Uint8Array(3));
    let calls = 0;
    const counting: ObjectStore = {
      ...store,
      async *list(p) {
        calls++;
        yield* store.list(p);
      },
      async get(k) {
        calls++;
        return store.get(k);
      },
    };
    const fs = await KrinoFs.open({ store: counting });
    calls = 0;
    expect(await fs.readdir("/a")).toEqual(["b.txt"]);
    expect((await fs.stat("/a/b.txt")).size).toBe(3);
    expect(await fs.exists("/nope")).toBe(false);
    expect(calls).toBe(0);
  });

  it("caches reads until the file changes", async () => {
    const store = memoryStore();
    await store.put("f.txt", new TextEncoder().encode("one"));
    let gets = 0;
    const fs = await KrinoFs.open({
      store: { ...store, get: (k) => (gets++, store.get(k)) },
    });
    await fs.readFile("/f.txt");
    await fs.readFile("/f.txt");
    expect(gets).toBe(1);
    await fs.writeFile("/f.txt", "two");
    expect(await fs.readFile("/f.txt")).toBe("two");
    expect(gets).toBe(1);
  });

  it("refresh picks up writes made by another agent", async () => {
    const store = memoryStore();
    const a = await KrinoFs.open({ store, prefix: "shared" });
    const b = await KrinoFs.open({ store, prefix: "shared" });
    await a.writeFile("/note.txt", "from a");
    expect(await b.exists("/note.txt")).toBe(false);
    await b.refresh();
    expect(await b.readFile("/note.txt")).toBe("from a");
  });

  it("writeIfUnchanged detects a concurrent edit", async () => {
    const store = memoryStore();
    const a = await KrinoFs.open({ store });
    const b = await KrinoFs.open({ store });
    await a.writeFile("/state.json", '{"n":1}');
    await b.refresh();
    const { version } = await a.readWithVersion("/state.json");
    const fromB = await b.readWithVersion("/state.json");
    await b.writeIfUnchanged("/state.json", '{"n":2}', fromB.version);
    await expect(a.writeIfUnchanged("/state.json", '{"n":3}', version)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("round-trips binary and base64", async () => {
    const fs = await KrinoFs.open({ store: memoryStore() });
    const bytes = new Uint8Array([0, 255, 128, 10]);
    await fs.writeFile("/bin.dat", bytes);
    expect(await fs.readFileBuffer("/bin.dat")).toEqual(bytes);
    expect(await fs.readFile("/bin.dat", "base64")).toBe("AP+ACg==");
    await fs.writeFile("/b64.dat", "AP+ACg==", "base64");
    expect(await fs.readFileBuffer("/b64.dat")).toEqual(bytes);
  });

  it("matches real filesystem errors", async () => {
    const fs = await KrinoFs.open({ store: memoryStore() });
    await fs.writeFile("/file", "x");
    await fs.mkdir("/dir");
    await fs.writeFile("/dir/child", "y");
    await expect(fs.readFile("/missing")).rejects.toThrow(/^ENOENT/);
    await expect(fs.readFile("/dir")).rejects.toThrow(/^EISDIR/);
    await expect(fs.writeFile("/file/x", "z")).rejects.toThrow(/^ENOTDIR/);
    await expect(fs.mkdir("/dir")).rejects.toThrow(/^EEXIST/);
    await expect(fs.rm("/dir")).rejects.toThrow(/^ENOTEMPTY/);
    await expect(fs.mv("/dir", "/dir/inner")).rejects.toThrow(/^EINVAL/);
    await expect(fs.symlink("/file", "/ln")).rejects.toThrow(/^EPERM/);
    await expect(fs.createExclusive("/file", { mode: 0o644 })).rejects.toThrow(/^EEXIST/);
  });

  it("warm loads a folder in parallel so grep doesn't fetch one by one", async () => {
    const store = memoryStore();
    for (let i = 0; i < 40; i++) await store.put(`f${i}.txt`, new Uint8Array(1));
    let inFlight = 0;
    let peak = 0;
    const fs = await KrinoFs.open({
      store: {
        ...store,
        async get(k) {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return store.get(k);
        },
      },
    });
    await fs.warm();
    expect(peak).toBeGreaterThan(1);
  });
});

describe("bashTool", () => {
  it("returns terminal-style output with exit codes", async () => {
    const { bash } = await setup({ "a.txt": "hi\n" });
    const tool = bashTool(bash);
    expect(await tool.execute({ command: "cat a.txt" })).toBe("hi\n");
    const fail = await tool.execute({ command: "cat nope.txt" });
    expect(fail).toMatch(/nope\.txt/);
    expect(fail).toMatch(/\[exit code 1\]$/);
  });
});
