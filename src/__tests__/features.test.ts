import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  authorize,
  ConflictError,
  createBash,
  createToken,
  journaled,
  KrinoFs,
  memoryStore,
  verifyToken,
  type ObjectStore,
  type SqlLike,
} from "../index.js";

const SECRET = "test-secret-at-least-16";
const enc = new TextEncoder();
const text = (store: ReturnType<typeof memoryStore>, key: string) => {
  const obj = store.objects.get(key);
  return obj ? new TextDecoder().decode(obj.body) : undefined;
};

/** node:sqlite shaped like a Durable Object's `ctx.storage.sql`. */
function sqlite(db = new DatabaseSync(":memory:")): SqlLike & { db: DatabaseSync } {
  return {
    db,
    exec(query, ...bindings) {
      const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

function counting(store: ObjectStore) {
  const calls = { get: 0, getRange: 0, put: 0, copy: 0, delete: 0, list: 0 };
  const wrapped: ObjectStore = {
    list: (p) => (calls.list++, store.list(p)),
    get: (k) => (calls.get++, store.get(k)),
    getRange: (k, r) => (calls.getRange++, store.getRange!(k, r)),
    put: (k, b, o) => (calls.put++, store.put(k, b, o)),
    copy: (a, b) => (calls.copy++, store.copy!(a, b)),
    delete: (k) => (calls.delete++, store.delete(k)),
  };
  return { calls, store: wrapped };
}

describe("tokens", () => {
  it("round-trips claims and rejects tampering, wrong secrets and expiry", async () => {
    const token = await createToken(SECRET, { folder: "acme", agent: "writer", readOnly: true });
    expect(await verifyToken(SECRET, token)).toMatchObject({ folder: "acme", agent: "writer", readOnly: true });

    const [payload, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ folder: "other" })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyToken(SECRET, forged)).toBeNull();
    expect(await verifyToken(SECRET, `${payload}.${sig}x`)).toBeNull();
    expect(await verifyToken("another-secret-of-16+", token)).toBeNull();
    expect(await verifyToken(SECRET, "garbage")).toBeNull();

    const expired = await createToken(SECRET, { folder: "acme", expiresIn: -1 });
    expect(await verifyToken(SECRET, expired)).toBeNull();
    const fresh = await createToken(SECRET, { folder: "acme", expiresIn: 60 });
    expect(await verifyToken(SECRET, fresh)).toMatchObject({ folder: "acme", agent: "default", readOnly: false });
  });

  it("reads bearer tokens from requests and refuses short secrets", async () => {
    const token = await createToken(SECRET, { folder: "f" });
    const ok = new Request("https://x", { headers: { authorization: `Bearer ${token}` } });
    expect((await authorize(SECRET, ok))?.folder).toBe("f");
    expect(await authorize(SECRET, new Request("https://x"))).toBeNull();
    await expect(createToken("short", { folder: "f" })).rejects.toThrow(/16 characters/);
  });
});

describe("read-only sessions", () => {
  it("reads normally and refuses every write", async () => {
    const store = memoryStore();
    await store.put("p/a.txt", enc.encode("hello\n"));
    const shell = await createBash({ store, prefix: "p", readOnly: true });
    expect((await shell.exec("cat a.txt && grep -c hello a.txt")).stdout).toBe("hello\n1\n");
    for (const cmd of ["echo x > b.txt", "rm a.txt", "mkdir d", "mv a.txt c.txt", "sed -i s/h/j/ a.txt"]) {
      const r = await shell.exec(cmd);
      expect(r.exitCode, cmd).not.toBe(0);
    }
    expect((await shell.exec("echo x > b.txt")).stderr).toBe("bash: /workspace/b.txt: Read-only file system\n");
    expect([...store.objects.keys()]).toEqual(["p/a.txt"]);
    expect(text(store, "p/a.txt")).toBe("hello\n");
    expect((await shell.exec("echo scratch > /tmp/x && cat /tmp/x")).stdout).toBe("scratch\n");
  });
});

describe("shared folders", () => {
  it("gives each agent its own cd and export over one set of files", async () => {
    const store = memoryStore();
    const fs = await KrinoFs.open({ store, prefix: "team", writeBehind: true });
    const alice = await createBash({ fs });
    const bob = await createBash({ fs });
    const viewer = await createBash({ fs, readOnly: true });

    await alice.exec("mkdir -p src && cd src && export WHO=alice && echo 'from alice' > note.txt");
    await bob.exec("export WHO=bob");
    expect((await bob.exec("pwd; echo $WHO; cat src/note.txt")).stdout).toBe("/workspace\nbob\nfrom alice\n");
    expect((await alice.exec("pwd; echo $WHO")).stdout).toBe("/workspace/src\nalice\n");
    expect((await viewer.exec("cat src/note.txt")).stdout).toBe("from alice\n");
    expect((await viewer.exec("rm src/note.txt")).exitCode).not.toBe(0);
    expect(text(store, "team/src/note.txt")).toBe("from alice\n");
  });
});

describe("head and tail on big files", () => {
  const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1} ✓`);
  const big = `${lines.join("\n")}\n`;

  async function setupBig(content = big) {
    const base = memoryStore();
    await base.put("p/big.log", enc.encode(content));
    await base.put("p/small.txt", enc.encode("a\nb\nc\n"));
    const { calls, store } = counting(base);
    const shell = await createBash({ store, prefix: "p", bigFileBytes: 10_000 });
    return { calls, shell };
  }

  it("reads only the start or end and matches the real head/tail", async () => {
    const { calls, shell } = await setupBig();
    expect((await shell.exec("head -n 3 big.log")).stdout).toBe("line 1 ✓\nline 2 ✓\nline 3 ✓\n");
    expect((await shell.exec("head big.log")).stdout.split("\n")).toHaveLength(11);
    expect((await shell.exec("tail -n 2 big.log")).stdout).toBe("line 49999 ✓\nline 50000 ✓\n");
    expect((await shell.exec("tail -5 big.log | wc -l")).stdout.trim()).toBe("5");
    expect((await shell.exec("head -n 20000 big.log | tail -n 1")).stdout).toBe("line 20000 ✓\n");
    expect(calls.get).toBe(0);
    expect(calls.getRange).toBeGreaterThan(0);
  });

  it("handles a missing final newline and whole-file requests", async () => {
    const { shell } = await setupBig(big.trimEnd());
    expect((await shell.exec("tail -n 1 big.log")).stdout).toBe("line 50000 ✓");
    expect((await shell.exec("head -n 999999 big.log | wc -l")).stdout.trim()).toBe("49999");
  });

  it("leaves small files, pipes and other flags to just-bash", async () => {
    const { calls, shell } = await setupBig();
    expect((await shell.exec("head -n 2 small.txt")).stdout).toBe("a\nb\n");
    expect((await shell.exec("cat small.txt | tail -n 1")).stdout).toBe("c\n");
    expect((await shell.exec("tail -n +3 small.txt")).stdout).toBe("c\n");
    expect(calls.getRange).toBe(0);
  });
});

describe("journal", () => {
  async function setupJournal(seed: Record<string, string> = {}) {
    const base = memoryStore();
    for (const [k, v] of Object.entries(seed)) await base.put(k, enc.encode(v));
    const { calls, store: remote } = counting(base);
    const sql = sqlite();
    const store = journaled(remote, sql);
    return { base, calls, remote, sql, store };
  }

  it("commands save locally without waiting on the remote store", async () => {
    const { base, calls, store } = await setupJournal();
    const shell = await createBash({ store, prefix: "p" });
    calls.put = 0;
    await shell.exec("mkdir -p src && for i in 1 2 3; do echo $i > src/f$i.txt; done");
    expect(calls.put).toBe(0);
    expect(store.pending).toBe(4);
    expect((await shell.exec("cat src/f2.txt")).stdout).toBe("2\n");
    await store.drain();
    expect(store.pending).toBe(0);
    expect(text(base, "p/src/f3.txt")).toBe("3\n");
  });

  it("survives a crash before draining", async () => {
    const { base, remote, sql, store } = await setupJournal();
    const first = await createBash({ store, prefix: "p" });
    await first.exec("echo precious > keep.txt && mkdir empty");
    expect(base.objects.size).toBe(0);

    // A fresh process: new journal over the same database, new shell.
    const reopened = journaled(remote, sql);
    const second = await createBash({ store: reopened, prefix: "p" });
    expect((await second.exec("cat keep.txt && ls")).stdout).toBe("precious\nempty\nkeep.txt\n");
    await reopened.drain();
    expect(text(base, "p/keep.txt")).toBe("precious\n");
  });

  it("moves folders safely: copies land before the source is deleted", async () => {
    const { base, store } = await setupJournal({ "p/old/a.txt": "A", "p/old/b.txt": "B" });
    const shell = await createBash({ store, prefix: "p" });
    await shell.exec("mv old new && echo changed > new/a.txt");
    expect(text(base, "p/old/a.txt")).toBe("A");
    await store.drain();
    expect(text(base, "p/new/b.txt")).toBe("B");
    expect(text(base, "p/new/a.txt")).toBe("changed\n");
    expect([...base.objects.keys()].some((k) => k.startsWith("p/old/"))).toBe(false);
  });

  it("keeps a write made while a drain is running", async () => {
    const base = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ObjectStore = { ...base, put: async (k, b, o) => (await gate, base.put(k, b, o)) };
    const store = journaled(slow, sqlite());
    await store.put("k", enc.encode("v1"));
    const draining = store.drain();
    await store.put("k", enc.encode("v2"));
    release();
    await draining;
    expect(store.pending).toBe(1);
    await store.drain();
    expect(text(base, "k")).toBe("v2");
  });

  it("retries a failed drain and never loses the change", async () => {
    const base = memoryStore();
    let down = true;
    const flaky: ObjectStore = { ...base, put: (k, b, o) => (down ? Promise.reject(new Error("503")) : base.put(k, b, o)) };
    const store = journaled(flaky, sqlite());
    await store.put("k", enc.encode("v"));
    await expect(store.drain()).rejects.toThrow();
    expect(store.pending).toBe(1);
    down = false;
    await store.drain();
    expect(text(base, "k")).toBe("v");
  });

  it("version checks keep working before and after draining", async () => {
    const { store } = await setupJournal();
    const fs = await KrinoFs.open({ store });
    await fs.writeFile("/state.json", "1");
    const before = await fs.readWithVersion("/state.json");
    await store.drain();
    await fs.writeIfUnchanged("/state.json", "2", before.version);
    const after = await fs.readWithVersion("/state.json");
    await expect(fs.writeIfUnchanged("/state.json", "3", before.version)).rejects.toBeInstanceOf(ConflictError);
    await store.drain();
    await fs.writeIfUnchanged("/state.json", "3", after.version);
    expect(await fs.readFile("/state.json")).toBe("3");
  });

  it("sends files too big for a database row straight to the store", async () => {
    const { base, store } = await setupJournal();
    await store.put("big", new Uint8Array(2_000_000));
    expect(store.pending).toBe(0);
    expect(base.objects.get("big")?.size).toBe(2_000_000);
  });

  it("drops a copy whose source vanished instead of blocking the journal", async () => {
    const { base, store } = await setupJournal({ src: "x" });
    await store.copy!("src", "dst");
    await base.delete(["src"]);
    await store.put("other", enc.encode("y"));
    await store.drain();
    expect(store.pending).toBe(0);
    expect(text(base, "other")).toBe("y");
  });
});
