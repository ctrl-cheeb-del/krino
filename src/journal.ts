import {
  PreconditionFailedError,
  sliceRange,
  type ObjectInfo,
  type ObjectStore,
  type StoredObject,
} from "./store.js";

/**
 * The slice of a SQLite API the journal needs. A Durable Object's
 * `ctx.storage.sql` fits as-is.
 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface JournaledStore extends ObjectStore {
  /** Copy journaled changes to the underlying store. Safe to call any time. */
  drain(): Promise<void>;
  /** Changes not yet copied. */
  readonly pending: number;
}

export interface JournalOptions {
  /** Table name prefix, if one database holds several journals. Default `krino`. */
  table?: string;
  /** Parallel requests while draining. Default 32. */
  concurrency?: number;
}

type Row = {
  key: string;
  seq: number;
  op: "put" | "copy" | "delete";
  src: string | null;
  body: Uint8Array | null;
  size: number;
  etag: string;
  mtime: number;
};

// Durable Object SQLite rows max out at 2 MB; bigger files go straight to the store.
const MAX_JOURNALED = 1_500_000;

/**
 * Put a local SQLite journal in front of an object store. Writes land in the
 * journal (fast, and durable in a Durable Object) and `drain()` copies them
 * to the store later. Reads see journaled changes immediately.
 *
 * Only one process should write through a given journal; pair it with one
 * Durable Object per folder.
 */
export function journaled(store: ObjectStore, sql: SqlLike, options: JournalOptions = {}): JournaledStore {
  const t = options.table ?? "krino";
  const concurrency = options.concurrency ?? 32;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${t}_journal (key TEXT PRIMARY KEY, seq INTEGER NOT NULL, op TEXT NOT NULL, src TEXT, body BLOB, size INTEGER NOT NULL, etag TEXT NOT NULL, mtime INTEGER NOT NULL)`,
  );
  // Journal etags stay valid after draining: they map to the store's real etag.
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t}_etags (key TEXT PRIMARY KEY, alias TEXT NOT NULL, real TEXT NOT NULL)`);

  // Bindings disagree on blobs: Durable Objects document ArrayBuffer, Bun stores
  // an ArrayBuffer as NULL. Probe once and use whichever round-trips.
  sql.exec(`CREATE TABLE IF NOT EXISTS ${t}_probe (b BLOB)`);
  sql.exec(`DELETE FROM ${t}_probe`);
  sql.exec(`INSERT INTO ${t}_probe (b) VALUES (?)`, new Uint8Array([1]).buffer);
  const viaBuffer = sql.exec(`SELECT b FROM ${t}_probe`).toArray()[0]?.b != null;
  sql.exec(`DELETE FROM ${t}_probe`);
  const toBlob = viaBuffer ? toArrayBuffer : (body: Uint8Array) => body;

  const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let seq = Number(sql.exec(`SELECT coalesce(max(seq), 0) AS n FROM ${t}_journal`).toArray()[0]?.n ?? 0);
  let draining: Promise<void> | undefined;
  let inflight = new Set<string>();

  const rowOf = (key: string): Row | undefined => {
    const r = sql.exec(`SELECT * FROM ${t}_journal WHERE key = ?`, key).toArray()[0];
    return r && toRow(r);
  };

  const record = (key: string, op: Row["op"], fields: { src?: string; body?: Uint8Array; size: number }) => {
    const n = ++seq;
    const etag = op === "delete" ? "" : `j${epoch}.${n}`;
    const mtime = Date.now();
    sql.exec(
      `INSERT OR REPLACE INTO ${t}_journal (key, seq, op, src, body, size, etag, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      n,
      op,
      fields.src ?? null,
      fields.body ? toBlob(fields.body) : null,
      fields.size,
      etag,
      mtime,
    );
    return { key, size: fields.size, etag, mtime: new Date(mtime) };
  };

  const done = (row: Row, real?: string) => {
    sql.exec(`DELETE FROM ${t}_journal WHERE key = ? AND seq = ?`, row.key, row.seq);
    if (row.op === "delete") sql.exec(`DELETE FROM ${t}_etags WHERE key = ?`, row.key);
    else if (real) {
      sql.exec(`INSERT OR REPLACE INTO ${t}_etags (key, alias, real) VALUES (?, ?, ?)`, row.key, row.etag, real);
    }
  };

  /** Writes that must not race a drain of an older version of the same key. */
  const settled = async (key: string) => {
    while (draining && inflight.has(key)) await draining.catch(() => {});
  };

  const drainOnce = async () => {
    const rows = sql.exec(`SELECT * FROM ${t}_journal ORDER BY seq`).toArray().map(toRow);
    if (!rows.length) return;
    inflight = new Set(rows.map((r) => r.key));
    // Copies first, then writes, then deletes: a copy's source is still intact
    // even if it was overwritten or deleted after the copy was journaled.
    const copies = rows.filter((r) => r.op === "copy");
    const puts = rows.filter((r) => r.op === "put");
    const deletes = rows.filter((r) => r.op === "delete");

    let failed = 0;
    await pool(copies, concurrency, async (row) => {
      try {
        const info = store.copy
          ? await store.copy(row.src!, row.key)
          : await copyByHand(store, row.src!, row.key);
        done(row, info.etag);
      } catch (err) {
        // A vanished source can never be copied; drop it rather than block the journal.
        if ((await store.get(row.src!).catch(() => undefined)) === null) done(row);
        else failed++;
      }
    });
    if (failed) throw new Error(`journal: ${failed} copies failed`);

    await pool(puts, concurrency, async (row) => {
      try {
        done(row, (await store.put(row.key, row.body!)).etag);
      } catch {
        failed++;
      }
    });
    if (deletes.length) {
      try {
        await store.delete(deletes.map((r) => r.key));
        for (const row of deletes) done(row);
      } catch {
        failed++;
      }
    }
    if (failed) throw new Error(`journal: ${failed} changes failed to drain`);
  };

  const self: JournaledStore = {
    get pending() {
      return Number(sql.exec(`SELECT count(*) AS n FROM ${t}_journal`).toArray()[0]?.n ?? 0);
    },

    drain() {
      draining ??= drainOnce().finally(() => {
        draining = undefined;
        inflight = new Set();
      });
      return draining;
    },

    async *list(prefix) {
      const found = new Map<string, ObjectInfo>();
      for await (const o of store.list(prefix)) found.set(o.key, o);
      const rows = sql
        .exec(`SELECT key, op, src, size, etag, mtime FROM ${t}_journal WHERE substr(key, 1, ?) = ?`, prefix.length, prefix)
        .toArray()
        .map(toRow);
      // A copy's size is its source's; look up sources outside this listing in parallel.
      const sizes = new Map<string, number | null>();
      const unknown = [...new Set(rows.filter((r) => r.op === "copy" && !found.has(r.src!)).map((r) => r.src!))];
      await pool(unknown, concurrency, async (src) => {
        const head = store.getRange ? await store.getRange(src, { offset: 0, length: 1 }) : await store.get(src);
        sizes.set(src, head ? head.size : null);
      });
      for (const row of rows) {
        if (row.op === "delete") {
          found.delete(row.key);
          continue;
        }
        const size = row.op === "copy" ? (found.get(row.src!)?.size ?? sizes.get(row.src!)) : row.size;
        if (size == null) continue;
        found.set(row.key, { key: row.key, size, etag: row.etag, mtime: new Date(row.mtime) });
      }
      for (const key of [...found.keys()].sort()) yield found.get(key)!;
    },

    async get(key) {
      const row = rowOf(key);
      if (!row) return store.get(key);
      if (row.op === "delete") return null;
      if (row.op === "put") return { ...info(row), body: row.body! } satisfies StoredObject;
      const src = await store.get(row.src!);
      return src && { ...src, key, etag: row.etag };
    },

    async getRange(key, range) {
      const row = rowOf(key);
      if (row?.op === "delete") return null;
      if (row?.op === "put") return { body: sliceRange(row.body!, range), size: row.size, etag: row.etag };
      const target = row?.op === "copy" ? row.src! : key;
      if (store.getRange) {
        const part = await store.getRange(target, range);
        return part && (row ? { ...part, etag: row.etag } : part);
      }
      const whole = await store.get(target);
      return whole && { body: sliceRange(whole.body, range), size: whole.size, etag: row?.etag ?? whole.etag };
    },

    async put(key, body, opts) {
      const row = rowOf(key);
      if (opts?.ifMatch !== undefined || opts?.ifNoneMatch) {
        if (row) {
          const exists = row.op !== "delete";
          if (opts.ifNoneMatch && exists) throw new PreconditionFailedError();
          if (opts.ifMatch !== undefined && (!exists || row.etag !== opts.ifMatch)) {
            throw new PreconditionFailedError();
          }
        } else {
          // Nothing journaled for this key: the store holds the truth, so ask it.
          const alias = opts.ifMatch
            ? sql.exec(`SELECT real FROM ${t}_etags WHERE key = ? AND alias = ?`, key, opts.ifMatch).toArray()[0]
            : undefined;
          const ifMatch = alias ? String(alias.real) : opts.ifMatch;
          return store.put(key, body, { ...opts, ifMatch });
        }
      }
      if (body.byteLength > MAX_JOURNALED) {
        await settled(key);
        sql.exec(`DELETE FROM ${t}_journal WHERE key = ?`, key);
        return store.put(key, body);
      }
      return record(key, "put", { body, size: body.byteLength });
    },

    async delete(keys) {
      for (const key of keys) record(key, "delete", { size: 0 });
    },

    async copy(from, to) {
      const row = rowOf(from);
      if (row?.op === "delete") throw new Error(`no such key: ${from}`);
      if (row?.op === "put") {
        if (row.size > MAX_JOURNALED) return self.put(to, row.body!);
        return record(to, "put", { body: row.body!, size: row.size });
      }
      return record(to, "copy", { src: row?.op === "copy" ? row.src! : from, size: row?.size ?? 0 });
    },
  };
  return self;
}

function toRow(r: Record<string, unknown>): Row {
  const op = r.op as Row["op"];
  return {
    key: String(r.key),
    seq: Number(r.seq ?? 0),
    op,
    src: r.src == null ? null : String(r.src),
    // Some SQLite bindings store an empty blob as NULL.
    body: r.body == null ? (op === "put" ? new Uint8Array() : null) : new Uint8Array(r.body as ArrayBuffer),
    size: Number(r.size ?? 0),
    etag: String(r.etag ?? ""),
    mtime: Number(r.mtime ?? 0),
  };
}

function info(row: Row): ObjectInfo {
  return { key: row.key, size: row.size, etag: row.etag, mtime: new Date(row.mtime) };
}

function toArrayBuffer(body: Uint8Array): ArrayBuffer {
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function copyByHand(store: ObjectStore, from: string, to: string): Promise<ObjectInfo> {
  const src = await store.get(from);
  if (!src) throw new Error(`no such key: ${from}`);
  return store.put(to, src.body);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
