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
  const session = await createBash({ store, prefix });
  const run = async (cmd: string) => {
    const r = await session.exec(cmd);
    return { ...r, out: r.stdout.trimEnd() };
  };
  return { store, session, fs: session.fs, run };
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
    await first.exec("mkdir -p empty/inside && echo x > f/../keep.txt");
    await first.exec("mkdir tmpdir && touch tmpdir/x && rm tmpdir/x");

    const second = await createBash({ store, prefix: "p" });
    const ls = await second.exec("ls -a empty tmpdir; find . | sort");
    expect(ls.stdout).toContain("inside");
    expect(ls.stdout).not.toContain(".krino-dir");
    expect((await second.exec("test -d tmpdir && echo yes")).stdout).toBe("yes\n");
  });

  it("isolates prefixes and clamps traversal at the mount", async () => {
    const store = memoryStore();
    await store.put("other/secret.txt", new TextEncoder().encode("nope"));
    const { exec } = await createBash({ store, prefix: "mine" });
    const r = await exec("cat ../other/secret.txt; cat ../../other/secret.txt; ls /");
    expect(r.stdout).not.toContain("nope");
    await exec("echo hi > ../../escape.txt");
    expect(store.objects.has("escape.txt")).toBe(false);
  });

  it("keeps /tmp and /dev in memory, not in storage", async () => {
    const { run, store } = await setup();
    await run("echo scratch > /tmp/x && echo gone > /dev/null");
    expect((await run("cat /tmp/x")).out).toBe("scratch");
    expect(store.objects.size).toBe(0);
  });

  it("works when storage calls actually wait (timers inside just-bash's sandbox)", async () => {
    const base = memoryStore();
    const wait = () => new Promise((r) => setTimeout(r, 2));
    const slow: ObjectStore = {
      async *list(p) {
        await wait();
        yield* base.list(p);
      },
      get: async (k) => (await wait(), base.get(k)),
      put: async (k, b, o) => (await wait(), base.put(k, b, o)),
      delete: async (k) => (await wait(), base.delete(k)),
    };
    for (const f of ["a", "b"]) await base.put(`p/src/${f}.ts`, new TextEncoder().encode("import x\n"));
    const { exec } = await createBash({ store: slow, prefix: "p" });
    const r = await exec("sed -i 's/import/IMPORT/' src/*.ts && cat src/*.ts && grep -rc IMPORT src");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("IMPORT x\nIMPORT x\n");
  });

  it("gives the agent shell errors, never storage details", async () => {
    const failing: ObjectStore = {
      ...memoryStore(),
      async get() {
        throw new Error("S3 AccessDenied bucket=prod-agents key=s/1/x.txt");
      },
    };
    await failing.put("s/1/x.txt", new Uint8Array([104]));
    const { exec } = await createBash({ store: failing, prefix: "s/1" });
    const r = await exec("cat x.txt; cat missing.txt");
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
  it("keeps the start and the end of long output", async () => {
    const { session } = await setup();
    const out = await session.tool({ maxOutput: 200 }).execute({ command: "seq 1 1000" });
    expect(out.startsWith("1\n2\n")).toBe(true);
    expect(out).toContain("characters omitted");
    expect(out.trimEnd().endsWith("1000")).toBe(true);
  });

  it("returns terminal-style output with exit codes", async () => {
    const { session } = await setup({ "a.txt": "hi\n" });
    const tool = session.tool();
    expect(await tool.execute({ command: "cat a.txt" })).toBe("hi\n");
    const fail = await tool.execute({ command: "cat nope.txt" });
    expect(fail).toMatch(/nope\.txt/);
    expect(fail).toMatch(/\[exit code 1\]$/);
  });
});

describe("session", () => {
  it("keeps cd and exported variables between commands, like a terminal", async () => {
    const { run } = await setup({ "src/app.ts": "x\n" });
    await run("cd src && export MODE=dev && LOCAL=1");
    expect((await run("pwd; echo $MODE; ls")).out).toBe("/workspace/src\ndev\napp.ts");
    await run("cd /tmp");
    expect((await run("pwd")).out).toBe("/tmp");
  });

  it("falls back to /workspace when the current folder is deleted", async () => {
    const { run } = await setup({ "a/x": "1" });
    await run("cd a");
    await run("rm -rf /workspace/a");
    expect((await run("pwd")).out).toBe("/workspace");
  });

  it("saves each file once per command, in parallel", async () => {
    const store = memoryStore();
    let puts = 0;
    const session = await createBash({
      store: { ...store, put: (k, b, o) => (puts++, store.put(k, b, o)) },
    });
    await session.exec("echo a > f.txt && echo b >> f.txt && echo c > f.txt");
    expect(puts).toBe(1);
    expect(text(store, "f.txt")).toBe("c\n");
  });

  it("reports failed saves as a shell error and retries them on the next command", async () => {
    const store = memoryStore();
    let broken = true;
    const session = await createBash({
      store: {
        ...store,
        put: (k, b, o) => (broken ? Promise.reject(new Error("R2 503 bucket=x")) : store.put(k, b, o)),
      },
    });
    const first = await session.exec("echo hi > a.txt");
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toMatch(/Input\/output error/);
    expect(first.stderr).not.toMatch(/R2|bucket/);
    expect((await session.exec("cat a.txt")).stdout).toBe("hi\n");
    broken = false;
    await session.exec("true");
    expect(text(store, "a.txt")).toBe("hi\n");
  });

  it("never deletes a moved file's source when its copy failed", async () => {
    const store = memoryStore();
    await store.put("keep/a.txt", new TextEncoder().encode("precious"));
    let broken = true;
    const session = await createBash({
      store: {
        ...store,
        copy: (from, to) => (broken ? Promise.reject(new Error("boom")) : store.copy!(from, to)),
      },
    });
    const r = await session.exec("mv keep moved");
    expect(r.exitCode).toBe(1);
    expect(text(store, "keep/a.txt")).toBe("precious");
    broken = false;
    await session.exec("true");
    expect(text(store, "moved/a.txt")).toBe("precious");
    expect(text(store, "keep/a.txt")).toBeUndefined();
  });

  it("reads a file copied in the same command before it is saved", async () => {
    const { run, store } = await setup({ "a.txt": "one\n" });
    expect((await run("cp a.txt b.txt && echo two > a.txt && cat b.txt a.txt")).out).toBe("one\ntwo");
    expect(text(store, "s/1/b.txt")).toBe("one\n");
    expect(text(store, "s/1/a.txt")).toBe("two\n");
  });

  it("does not delete files recreated after rm -rf in the same command", async () => {
    const { run, store } = await setup({ "d/old.txt": "old" });
    await run("rm -rf d && mkdir d && echo new > d/new.txt");
    expect(text(store, "s/1/d/old.txt")).toBeUndefined();
    expect(text(store, "s/1/d/new.txt")).toBe("new\n");
  });

  it("runs overlapping exec calls one at a time", async () => {
    const { session } = await setup();
    await Promise.all([session.exec("cd /tmp"), session.exec("echo x > f.txt")]);
    expect((await session.exec("cat f.txt")).stdout).toBe("x\n");
  });
});
