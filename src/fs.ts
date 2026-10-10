import * as justBash from "just-bash";
import type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { encodingOf, fromBytes, toBytes } from "./encoding.js";
import { basename, dirname, isWithin, join, normalize, resolve } from "./paths.js";
import { PreconditionFailedError, type ObjectInfo, type ObjectStore } from "./store.js";

/** Marks a directory that has no files in it; never shown to the agent. */
export const DIR_MARKER = ".krino-dir";

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const EMPTY = new Uint8Array();

type Node =
  | { type: "file"; size: number; etag: string; mtime: Date; mode: number }
  | { type: "dir"; mtime: Date; mode: number; marker: boolean };

/** A change not yet sent to storage. `etag` is the placeholder the node carries meanwhile. */
type Pending =
  | { op: "put"; body: Uint8Array; etag: string }
  | { op: "copy"; from: string; etag: string }
  | { op: "delete" };

export interface KrinoFsOptions {
  store: ObjectStore;
  /** Key prefix that isolates this filesystem, e.g. `sessions/abc123`. */
  prefix?: string;
  /** Bytes of file content kept in memory between reads. Default 32 MB. */
  cacheBytes?: number;
  /** Parallel storage requests for bulk work (flush, warm, copy). Default 32. */
  concurrency?: number;
  /**
   * Hold writes in memory until `flush()`, then send them in parallel. A file
   * written twice costs one request. Default false; `createBash` turns it on
   * and flushes after every command.
   */
  writeBehind?: boolean;
}

/** Thrown by `writeIfUnchanged` when someone else changed the file first. */
export class ConflictError extends Error {
  constructor(path: string) {
    super(`file changed since it was read: ${path}`);
    this.name = "ConflictError";
  }
}

/** Thrown by `flush()`; the failed changes stay queued for the next flush. */
export class FlushError extends Error {
  constructor(
    readonly failed: number,
    options?: { cause?: unknown },
  ) {
    super(`failed to save ${failed} change${failed === 1 ? "" : "s"} to storage`, options);
    this.name = "FlushError";
  }
}

const MESSAGES: Record<string, string> = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  ENOTEMPTY: "directory not empty",
  EPERM: "operation not permitted",
  EINVAL: "invalid argument",
  EACCES: "permission denied",
  EIO: "input/output error",
};

function fsError(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${MESSAGES[code]}, ${syscall} '${path}'`), { code });
}

/**
 * A just-bash filesystem whose files live in object storage.
 *
 * The directory tree is listed once on `open()` and kept in memory, so `ls`,
 * `stat`, `find` and `cd` never touch the network; only file contents are
 * read and written remotely. Writes by other processes become visible after
 * `refresh()`.
 */
export class KrinoFs implements IFileSystem {
  private readonly store: ObjectStore;
  private readonly prefix: string;
  private readonly cacheLimit: number;
  private readonly concurrency: number;
  private readonly writeBehind: boolean;
  private nodes = new Map<string, Node>();
  private children = new Map<string, Set<string>>();
  private cache = new Map<string, { etag: string; body: Uint8Array }>();
  private cacheSize = 0;
  private pending = new Map<string, Pending>();
  private inflight = new Map<string, Pending>();
  private sweeps = new Set<string>();
  private flushing?: Promise<void>;
  private version = 0;

  static async open(options: KrinoFsOptions): Promise<KrinoFs> {
    const fs = new KrinoFs(options);
    await fs.refresh();
    return fs;
  }

  private constructor(options: KrinoFsOptions) {
    this.store = options.store;
    const clean = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = clean ? `${clean}/` : "";
    this.cacheLimit = options.cacheBytes ?? 32 * 1024 * 1024;
    this.concurrency = options.concurrency ?? 32;
    this.writeBehind = options.writeBehind ?? false;
    this.reset();
  }

  /** Number of changes waiting for `flush()`. */
  get unsaved(): number {
    return this.pending.size + this.sweeps.size;
  }

  /** Re-list storage, picking up changes made outside this instance. */
  async refresh(): Promise<void> {
    await this.flush();
    const found: ObjectInfo[] = [];
    await this.io("scandir", "/", async () => {
      for await (const o of this.store.list(this.prefix)) found.push(o);
    });
    this.reset();
    for (const o of found) {
      const rel = o.key.slice(this.prefix.length);
      if (!rel) continue;
      if (rel.endsWith("/")) {
        this.addDir(normalize(rel), true);
      } else if (basename(rel) === DIR_MARKER) {
        this.addDir(normalize(dirname(`/${rel}`)), true);
      } else {
        this.addFile(normalize(rel), o, FILE_MODE);
      }
    }
  }

  /**
   * Send queued writes to storage in parallel: copies, then writes, then
   * deletes, so a move never deletes its source before the copy lands.
   */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (!this.pending.size && !this.sweeps.size) return;
    const batch = this.pending;
    const sweeps = this.sweeps;
    this.pending = new Map();
    this.sweeps = new Set();
    this.inflight = batch;
    this.flushing = this.send(batch, sweeps).finally(() => {
      this.inflight = new Map();
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /**
   * Load every file under `dir` into the read cache in parallel, so a
   * following `grep -r` doesn't fetch files one at a time.
   */
  async warm(dir = "/"): Promise<void> {
    const root = normalize(dir);
    const paths = [...this.nodes]
      .filter(([p, n]) => n.type === "file" && n.size > 0 && isWithin(p, root) && !this.cached(p))
      .map(([p]) => p);
    await pool(paths, this.concurrency, (p) => this.readFileBuffer(p).then(() => {}));
  }

  /** Read with a version token for `writeIfUnchanged`. Not exposed to the agent. */
  async readWithVersion(path: string): Promise<{ content: string; version: string }> {
    await this.flush();
    const content = await this.readFile(path);
    const node = this.nodes.get(normalize(path));
    return { content, version: node?.type === "file" ? node.etag : "" };
  }

  /** Write only if nobody changed the file since `version` was read. */
  async writeIfUnchanged(path: string, content: FileContent, version: string): Promise<void> {
    const p = normalize(path);
    this.assertWritableFile(p, "open");
    await this.flush();
    const body = toBytes(content);
    try {
      const info = await trusted(() => this.store.put(this.key(p), body, { ifMatch: version }));
      this.addFile(p, info, FILE_MODE);
      this.remember(p, info.etag, body);
    } catch (err) {
      if (err instanceof PreconditionFailedError) throw new ConflictError(p);
      throw fsError("EIO", "write", p);
    }
  }

  // --- IFileSystem ---------------------------------------------------------

  async readFile(
    path: string,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<string> {
    return fromBytes(await this.readFileBuffer(path), encodingOf(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", "open", path);
    if (node.type === "dir") throw fsError("EISDIR", "read", path);
    if (node.size === 0) return new Uint8Array();

    const hit = this.cached(p);
    if (hit && hit.etag === node.etag) return hit.body.slice();

    const key = this.key(p);
    const queued = this.pending.get(key) ?? this.inflight.get(key);
    if (queued?.op === "put") return queued.body.slice();

    const from = queued?.op === "copy" ? queued.from : key;
    const obj = await this.io("open", path, () => this.store.get(from));
    if (!obj) {
      this.removeTree(p);
      throw fsError("ENOENT", "open", path);
    }
    if (!queued) this.addFile(p, obj, node.mode);
    this.remember(p, queued ? node.etag : obj.etag, obj.body);
    return obj.body.slice();
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const p = normalize(path);
    this.assertWritableFile(p, "open");
    const body = toBytes(content, encodingOf(options)).slice();
    const etag = this.placeholder();
    this.stage(this.key(p), { op: "put", body, etag });
    this.addFile(p, { size: body.byteLength, etag, mtime: new Date() }, this.modeOf(p));
    this.remember(p, etag, body);
    await this.commit("write", path);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const p = normalize(path);
    const existing = this.nodes.has(p) ? await this.readFileBuffer(p) : EMPTY;
    const added = toBytes(content, encodingOf(options));
    const body = new Uint8Array(existing.length + added.length);
    body.set(existing);
    body.set(added, existing.length);
    await this.writeFile(p, body);
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(normalize(path));
  }

  async stat(path: string): Promise<FsStat> {
    return this.statOf(path, "stat");
  }

  async lstat(path: string): Promise<FsStat> {
    return this.statOf(path, "lstat");
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (node) {
      if (options?.recursive && node.type === "dir") return;
      throw fsError("EEXIST", "mkdir", path);
    }
    if (!options?.recursive && !this.nodes.has(dirname(p))) throw fsError("ENOENT", "mkdir", path);
    this.assertNoFileAncestor(p, "mkdir", path);
    this.stage(this.markerKey(p), { op: "put", body: EMPTY, etag: this.placeholder() });
    this.addDir(p, true);
    await this.commit("mkdir", path);
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    const p = normalize(path);
    if (this.nodes.has(p)) throw fsError("EEXIST", "open", path);
    if (!this.nodes.has(dirname(p))) throw fsError("ENOENT", "open", path);
    if (options.directory) return this.mkdir(p);
    this.assertWritableFile(p, "open");
    // Exclusivity needs the storage-side check, so this one can't wait.
    await this.flush().catch(() => {});
    let info: ObjectInfo;
    try {
      info = await trusted(() => this.store.put(this.key(p), EMPTY, { ifNoneMatch: "*" }));
    } catch (err) {
      if (err instanceof PreconditionFailedError) throw fsError("EEXIST", "open", path);
      throw fsError("EIO", "open", path);
    }
    this.addFile(p, info, options.mode);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", "scandir", path);
    if (node.type !== "dir") throw fsError("ENOTDIR", "scandir", path);
    return [...(this.children.get(p) ?? [])].sort();
  }

  async readdirWithFileTypes(path: string) {
    const p = normalize(path);
    return (await this.readdir(p)).map((name) => {
      const isDirectory = this.nodes.get(join(p, name))?.type === "dir";
      return { name, isFile: !isDirectory, isDirectory, isSymbolicLink: false };
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) {
      if (options?.force) return;
      throw fsError("ENOENT", "rm", path);
    }
    if (node.type === "dir" && this.children.get(p)?.size && !options?.recursive) {
      throw fsError("ENOTEMPTY", "rm", path);
    }

    for (const key of node.type === "file" ? [this.key(p)] : this.keysUnder(p)) {
      this.stage(key, { op: "delete" });
    }
    // Also sweep storage, so files written by someone else don't survive as orphans.
    if (node.type === "dir") this.sweeps.add(this.dirKeyPrefix(p));

    if (p === "/") this.clearTree();
    else {
      this.removeTree(p);
      this.keepParent(p);
    }
    await this.commit("rm", path);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const s = normalize(src);
    const d = normalize(dest);
    const node = this.nodes.get(s);
    if (!node) throw fsError("ENOENT", "cp", src);
    if (node.type === "dir" && !options?.recursive) throw fsError("EISDIR", "cp", src);
    if (node.type === "dir" && isWithin(d, s)) throw fsError("EINVAL", "cp", dest);
    await this.copyTree(s, d, "cp");
    await this.commit("cp", dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    const s = normalize(src);
    const d = normalize(dest);
    const node = this.nodes.get(s);
    if (!node) throw fsError("ENOENT", "mv", src);
    if (s === d) return;
    if (node.type === "dir" && isWithin(d, s)) {
      throw Object.assign(new Error(`EINVAL: cannot move '${src}' into itself, '${dest}'`), {
        code: "EINVAL",
      });
    }
    const target = this.nodes.get(d);
    if (target?.type === "dir") {
      if (node.type === "file") throw fsError("EISDIR", "rename", dest);
      if (this.children.get(d)?.size) throw fsError("ENOTEMPTY", "rename", dest);
    }
    if (target?.type === "file" && node.type === "dir") throw fsError("ENOTDIR", "rename", dest);
    // Object storage has no rename: copy everything, then delete the source.
    await this.copyTree(s, d, "rename");
    await this.rm(s, { recursive: true });
  }

  resolvePath(base: string, path: string): string {
    return resolve(base, path);
  }

  getAllPaths(): string[] {
    return [...this.nodes.keys()];
  }

  /** Kept for this session only; object storage has no file modes. */
  async chmod(path: string, mode: number): Promise<void> {
    const node = this.nodes.get(normalize(path));
    if (!node) throw fsError("ENOENT", "chmod", path);
    node.mode = mode;
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw fsError("EPERM", "symlink", linkPath);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw fsError("EPERM", "link", newPath);
  }

  async readlink(path: string): Promise<string> {
    if (!this.nodes.has(normalize(path))) throw fsError("ENOENT", "readlink", path);
    throw fsError("EINVAL", "readlink", path);
  }

  async realpath(path: string): Promise<string> {
    const p = normalize(path);
    if (!this.nodes.has(p)) throw fsError("ENOENT", "realpath", path);
    return p;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const node = this.nodes.get(normalize(path));
    if (!node) throw fsError("ENOENT", "utime", path);
    node.mtime = mtime;
  }

  // --- writes --------------------------------------------------------------

  private stage(key: string, change: Pending): void {
    this.pending.set(key, change);
  }

  /** Without write-behind every change is saved before the call returns. */
  private async commit(syscall: string, path: string): Promise<void> {
    if (this.writeBehind) return;
    try {
      await this.flush();
    } catch {
      throw fsError("EIO", syscall, path);
    }
  }

  private placeholder(): string {
    return `~${++this.version}`;
  }

  private async send(batch: Map<string, Pending>, sweeps: Set<string>): Promise<void> {
    const copies: [string, Extract<Pending, { op: "copy" }>][] = [];
    const puts: [string, Extract<Pending, { op: "put" }>][] = [];
    const deletes: string[] = [];
    for (const [key, change] of batch) {
      if (change.op === "copy") copies.push([key, change]);
      else if (change.op === "put") puts.push([key, change]);
      else deletes.push(key);
    }

    const failed: [string, Pending][] = [];
    let cause: unknown;
    const attempt = async (key: string, change: Pending, run: () => Promise<ObjectInfo>) => {
      try {
        this.settle(key, change, await trusted(run));
      } catch (err) {
        cause ??= err;
        failed.push([key, change]);
      }
    };

    await pool(copies, this.concurrency, ([key, c]) => attempt(key, c, () => this.store.copy!(c.from, key)));
    await pool(puts, this.concurrency, ([key, c]) => attempt(key, c, () => this.store.put(key, c.body)));

    // A failed copy or write means its source must not be deleted yet.
    if (failed.length) {
      this.requeue(failed, deletes, sweeps);
      throw new FlushError(failed.length + deletes.length + sweeps.size, { cause });
    }

    try {
      const doomed = new Set(deletes);
      for (const prefix of sweeps) {
        await trusted(async () => {
          for await (const o of this.store.list(prefix)) {
            if (!batch.has(o.key) && !this.pending.has(o.key)) doomed.add(o.key);
          }
        });
      }
      if (doomed.size) await trusted(() => this.store.delete([...doomed]));
    } catch (err) {
      this.requeue([], deletes, sweeps);
      throw new FlushError(deletes.length + sweeps.size, { cause: err });
    }
  }

  /** Swap a placeholder etag for the real one, unless the file changed again since. */
  private settle(key: string, change: Pending, info: ObjectInfo): void {
    if (change.op === "delete") return;
    const p = `/${key.slice(this.prefix.length)}`;
    const node = this.nodes.get(p);
    if (node?.type !== "file" || node.etag !== change.etag) return;
    node.etag = info.etag;
    const hit = this.cache.get(p);
    if (hit?.etag === change.etag) hit.etag = info.etag;
  }

  private requeue(failed: [string, Pending][], deletes: string[], sweeps: Set<string>): void {
    for (const [key, change] of failed) if (!this.pending.has(key)) this.pending.set(key, change);
    for (const key of deletes) if (!this.pending.has(key)) this.pending.set(key, { op: "delete" });
    for (const prefix of sweeps) this.sweeps.add(prefix);
  }

  private async copyTree(src: string, dest: string, syscall: string): Promise<void> {
    const node = this.nodes.get(src)!;
    if (node.type === "file") {
      this.assertWritableFile(dest, syscall);
      await this.copyFile(src, dest, node);
      return;
    }
    if (!this.nodes.has(dest)) {
      this.assertNoFileAncestor(dest, syscall, dest);
      this.stage(this.markerKey(dest), { op: "put", body: EMPTY, etag: this.placeholder() });
      this.addDir(dest, true);
    }
    const entries = [...this.nodes].filter(([p]) => p !== src && isWithin(p, src));
    for (const [p, n] of entries) {
      if (n.type !== "dir") continue;
      const target = dest + p.slice(src.length);
      if (n.marker) this.stage(this.markerKey(target), { op: "put", body: EMPTY, etag: this.placeholder() });
      this.addDir(target, n.marker);
    }
    const files = entries.filter((e): e is [string, Extract<Node, { type: "file" }>] => e[1].type === "file");
    await pool(files, this.concurrency, ([p, n]) => this.copyFile(p, dest + p.slice(src.length), n));
  }

  private async copyFile(src: string, dest: string, node: Extract<Node, { type: "file" }>): Promise<void> {
    const srcKey = this.key(src);
    const queued = this.pending.get(srcKey) ?? this.inflight.get(srcKey);
    const etag = this.placeholder();
    let change: Pending;
    if (queued?.op === "put") change = { op: "put", body: queued.body, etag };
    else if (queued?.op === "copy") change = { op: "copy", from: queued.from, etag };
    else if (this.store.copy) change = { op: "copy", from: srcKey, etag };
    else change = { op: "put", body: await this.readFileBuffer(src), etag };

    this.stage(this.key(dest), change);
    this.addFile(dest, { size: node.size, etag, mtime: new Date() }, node.mode);
    const hit = this.cached(src);
    if (hit) this.remember(dest, etag, hit.body);
  }

  // --- tree ----------------------------------------------------------------

  private key(path: string): string {
    return this.prefix + path.slice(1);
  }

  private dirKeyPrefix(dir: string): string {
    return dir === "/" ? this.prefix : `${this.key(dir)}/`;
  }

  private markerKey(dir: string): string {
    return this.dirKeyPrefix(dir) + DIR_MARKER;
  }

  private modeOf(path: string): number {
    return this.nodes.get(path)?.mode ?? FILE_MODE;
  }

  /** Storage errors never reach the agent: no bucket names, keys or endpoints. */
  private async io<T>(syscall: string, path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await trusted(fn);
    } catch {
      throw fsError("EIO", syscall, path);
    }
  }

  private reset(): void {
    this.clearTree();
    this.cache.clear();
    this.cacheSize = 0;
  }

  private clearTree(): void {
    this.nodes = new Map([["/", { type: "dir", mtime: new Date(), mode: DIR_MODE, marker: true }]]);
    this.children = new Map([["/", new Set()]]);
  }

  private attach(path: string): void {
    const parent = dirname(path);
    if (!this.nodes.has(parent)) this.addDir(parent, false);
    this.children.get(parent)!.add(basename(path));
  }

  private addDir(path: string, marker: boolean): void {
    const existing = this.nodes.get(path);
    if (existing?.type === "dir") {
      existing.marker ||= marker;
      return;
    }
    this.nodes.set(path, { type: "dir", mtime: new Date(), mode: DIR_MODE, marker });
    this.children.set(path, new Set());
    if (path !== "/") this.attach(path);
  }

  private addFile(path: string, info: Pick<ObjectInfo, "size" | "etag" | "mtime">, mode: number): void {
    this.nodes.set(path, { type: "file", size: info.size, etag: info.etag, mtime: info.mtime, mode });
    this.attach(path);
  }

  private removeTree(path: string): void {
    for (const p of [...this.nodes.keys()]) {
      if (!isWithin(p, path)) continue;
      this.nodes.delete(p);
      this.children.delete(p);
      this.forget(p);
    }
    this.children.get(dirname(path))?.delete(basename(path));
  }

  /** An emptied directory with no marker would vanish on the next listing. */
  private keepParent(path: string): void {
    const parent = dirname(path);
    const node = this.nodes.get(parent);
    if (parent === "/" || node?.type !== "dir" || node.marker) return;
    if (this.children.get(parent)?.size) return;
    this.stage(this.markerKey(parent), { op: "put", body: EMPTY, etag: this.placeholder() });
    node.marker = true;
  }

  private keysUnder(dir: string): string[] {
    const keys: string[] = [];
    for (const [p, n] of this.nodes) {
      if (!isWithin(p, dir)) continue;
      if (n.type === "file") keys.push(this.key(p));
      else if (n.marker && p !== "/") keys.push(this.markerKey(p));
    }
    return keys;
  }

  private statOf(path: string, syscall: string): FsStat {
    const node = this.nodes.get(normalize(path));
    if (!node) throw fsError("ENOENT", syscall, path);
    return {
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: false,
      mode: node.mode,
      size: node.type === "file" ? node.size : 4096,
      mtime: node.mtime,
    };
  }

  private assertWritableFile(p: string, syscall: string): void {
    if (this.nodes.get(p)?.type === "dir" || p === "/") throw fsError("EISDIR", syscall, p);
    if (basename(p) === DIR_MARKER) throw fsError("EACCES", syscall, p);
    this.assertNoFileAncestor(p, syscall, p);
  }

  private assertNoFileAncestor(p: string, syscall: string, shown: string): void {
    for (let d = dirname(p); d !== "/"; d = dirname(d)) {
      if (this.nodes.get(d)?.type === "file") throw fsError("ENOTDIR", syscall, shown);
    }
  }

  // --- read cache (LRU: Map keeps insertion order, re-inserting moves to the end)

  private cached(path: string) {
    const hit = this.cache.get(path);
    if (hit) {
      this.cache.delete(path);
      this.cache.set(path, hit);
    }
    return hit;
  }

  private remember(path: string, etag: string, body: Uint8Array): void {
    this.forget(path);
    if (body.byteLength > this.cacheLimit / 4) return;
    this.cache.set(path, { etag, body });
    this.cacheSize += body.byteLength;
    for (const [p, entry] of this.cache) {
      if (this.cacheSize <= this.cacheLimit) break;
      this.cache.delete(p);
      this.cacheSize -= entry.body.byteLength;
    }
  }

  private forget(path: string): void {
    const hit = this.cache.get(path);
    if (!hit) return;
    this.cache.delete(path);
    this.cacheSize -= hit.body.byteLength;
  }
}

// The browser/Workers build of just-bash has no sandbox and doesn't export this.
const BOX_EXPORT = "DefenseInDepthBox";
const box = (justBash as Record<string, unknown>)[BOX_EXPORT] as
  | { runTrustedAsync<T>(fn: () => Promise<T>): Promise<T> }
  | undefined;

/**
 * Storage clients use timers and their own promises, which just-bash's
 * sandbox blocks while a command runs. krino is host code, so it opts out.
 */
function trusted<T>(fn: () => Promise<T>): Promise<T> {
  return box ? box.runTrustedAsync(fn) : fn();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
