// Latency benchmark: every storage call waits LATENCY ms, roughly an R2 round trip.
import { Database } from "bun:sqlite";
import { createBash, journaled, memoryStore, type ObjectStore } from "../src/index.ts";

// JOURNAL=1 puts a local SQLite journal in front, as a Durable Object would.
const JOURNAL = process.env.JOURNAL === "1";

const LATENCY = Number(process.env.LATENCY ?? 20);
const sleep = () => new Promise((r) => setTimeout(r, LATENCY));

function slow(store: ObjectStore, counter: { n: number }): ObjectStore {
  return {
    async *list(p) {
      counter.n++;
      await sleep();
      yield* store.list(p);
    },
    get: async (k) => (counter.n++, await sleep(), store.get(k)),
    put: async (k, b, o) => (counter.n++, await sleep(), store.put(k, b, o)),
    delete: async (k) => (counter.n++, await sleep(), store.delete(k)),
    ...(store.copy && { copy: async (a: string, b: string) => (counter.n++, await sleep(), store.copy!(a, b)) }),
  };
}

const base = memoryStore();
const enc = new TextEncoder();
for (let d = 0; d < 10; d++) {
  for (let f = 0; f < 20; f++) {
    await base.put(`p/src/mod${d}/file${f}.ts`, enc.encode(`import x from "y";\nexport const v${f} = ${f};\n`.repeat(5)));
  }
}
for (let f = 0; f < 50; f++) await base.put(`p/assets/a${f}.txt`, enc.encode("asset\n"));

const counter = { n: 0 };
const remote = slow(base, counter);
const db = new Database(":memory:");
const store = JOURNAL
  ? journaled(remote, {
      exec(q, ...b) {
        const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    })
  : remote;
const rows: [string, number, number][] = [];
async function time(label: string, fn: () => Promise<unknown>) {
  counter.n = 0;
  const t = performance.now();
  await fn();
  rows.push([label, performance.now() - t, counter.n]);
}

let shell!: Awaited<ReturnType<typeof createBash>>;
await time("open (250 files)", async () => (shell = await createBash({ store, prefix: "p" })));
const run = async (cmd: string) => {
  const r = await shell.exec(cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout;
};
await time("ls -R + find", () => run("ls -R > /dev/null && find . -name '*.ts' | wc -l"));
await time("grep -rn (200 files, cold)", () => run("grep -rn 'export const v3 ' src | wc -l"));
await time("grep -rn (200 files, warm)", () => run("grep -rn 'export const v4 ' src | wc -l"));
await time("sed -i on 20 files", () => run("sed -i 's/import/IMPORT/' src/mod1/*.ts"));
await time("write 30 files in a loop", () => run("for i in $(seq 1 30); do echo $i > out$i.txt; done"));
await time("mv folder (50 files)", () => run("mv assets static"));
await time("rm -rf folder (50 files)", () => run("rm -rf static"));
await time("cat one file x10", () => run("for i in 1 2 3 4 5 6 7 8 9 10; do cat src/mod2/file1.ts > /dev/null; done"));

const total = rows.reduce((s, r) => s + r[1], 0);
console.log(`latency ${LATENCY} ms per storage call${JOURNAL ? ", journaled" : ""}\n`);
for (const [label, ms, calls] of rows) {
  console.log(`${label.padEnd(30)} ${ms.toFixed(0).padStart(6)} ms ${String(calls).padStart(5)} calls`);
}
console.log(`${"total".padEnd(30)} ${total.toFixed(0).padStart(6)} ms`);
