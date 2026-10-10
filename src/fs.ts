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
const COPY_CONCURRENCY = 16;

type Node =
  | { type: "file"; size: number; etag: string; mtime: Date; mode: number }
  | { type: "dir"; mtime: Date; mode: number; marker: boolean };

export interface KrinoFsOptions {
  store: ObjectStore;
  /** Key prefix that isolates this filesystem, e.g. `sessions/abc123`. */
  prefix?: string;
  /** Bytes of file content kept in memory between reads. Default 32 MB. */
  cacheBytes?: number;
}

/** Thrown by `writeIfUnchanged` when someone else changed the file first. */
export class ConflictError extends Error {
  constructor(path: string) {
    super(`file changed since it was read: ${path}`);
    this.name = "ConflictError";
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
  private nodes = new Map<string, Node>();
  private children = new Map<string, Set<string>>();
  private cache = new Map<string, { etag: string; body: Uint8Array }>();
  private cacheSize = 0;

  static async open(options: KrinoFsOptions): Promise<KrinoFs> {
    const fs = new KrinoFs(options);
    await fs.refresh();
    return fs;
  }

  private constructor({ store, prefix = "", cacheBytes = 32 * 1024 * 1024 }: KrinoFsOptions) {
    this.store = store;
    const clean = prefix.replace(/^\/+|\/+$/g, "");
    this.prefix = clean ? `${clean}/` : "";
    this.cacheLimit = cacheBytes;
    this.reset();
  }

  /** Re-list storage, picking up changes made outside this instance. */
  async refresh(): Promise<void> {
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
   * Load every file under `dir` into the read cache in parallel, so a
   * following `grep -r` or `cat **` doesn't fetch files one at a time.
   */
  async warm(dir = "/"): Promise<void> {
    const root = normalize(dir);
    const paths = [...this.nodes]
      .filter(([p, n]) => n.type === "file" && isWithin(p, root) && !this.cached(p))
      .map(([p]) => p);
    await pool(paths, COPY_CONCURRENCY, (p) => this.readFileBuffer(p).then(() => {}));
  }

  /** Read with a version token for `writeIfUnchanged`. Not exposed to the agent. */
  async readWithVersion(path: string): Promise<{ content: string; version: string }> {
    const content = await this.readFile(path);
    const node = this.nodes.get(normalize(path));
    return { content, version: node?.type === "file" ? node.etag : "" };
  }

  /** Write only if nobody changed the file since `version` was read. */
  async writeIfUnchanged(path: string, content: FileContent, version: string): Promise<void> {
    const p = normalize(path);
    this.assertWritableFile(p, "open");
    const body = toBytes(content);
    try {
      const info = await this.store.put(this.key(p), body, { ifMatch: version });
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

    const hit = this.cached(p);
    if (hit && hit.etag === node.etag) return hit.body.slice();

    const obj = await this.io("open", path, () => this.store.get(this.key(p)));
    if (!obj) {
      this.removeTree(p);
      throw fsError("ENOENT", "open", path);
    }
    this.addFile(p, obj, node.mode);
    this.remember(p, obj.etag, obj.body);
    return obj.body.slice();
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const p = normalize(path);
    this.assertWritableFile(p, "open");
    const body = toBytes(content, encodingOf(options));
    const info = await this.io("write", path, () => this.store.put(this.key(p), body));
    const prev = this.nodes.get(p);
    this.addFile(p, info, prev?.mode ?? FILE_MODE);
    this.remember(p, info.etag, body);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const p = normalize(path);
    const existing = this.nodes.has(p) ? await this.readFileBuffer(p) : new Uint8Array();
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
    const parent = this.nodes.get(dirname(p));
    if (!options?.recursive && !parent) throw fsError("ENOENT", "mkdir", path);
    this.assertNoFileAncestor(p, "mkdir", path);
    await this.io("mkdir", path, () =>
      this.store.put(this.markerKey(p), new Uint8Array()),
    );
    this.addDir(p, true);
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    const p = normalize(path);
    if (this.nodes.has(p)) throw fsError("EEXIST", "open", path);
    if (!this.nodes.has(dirname(p))) throw fsError("ENOENT", "open", path);
    if (options.directory) return this.mkdir(p);
    this.assertWritableFile(p, "open");
    let info: ObjectInfo;
    try {
      info = await this.store.put(this.key(p), new Uint8Array(), { ifNoneMatch: "*" });
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

    const keys =
      node.type === "file"
        ? [this.key(p)]
        : // List storage too, so files written by someone else don't survive as orphans.
          await this.io("rm", path, async () => {
            const found = new Set(this.keysUnder(p));
            for await (const o of this.store.list(this.dirKeyPrefix(p))) found.add(o.key);
            return [...found];
          });
    await this.io("rm", path, () => this.store.delete(keys));

    if (p === "/") {
      this.reset();
      return;
    }
    this.removeTree(p);
    await this.keepParent(p);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const s = normalize(src);
    const d = normalize(dest);
    const node = this.nodes.get(s);
    if (!node) throw fsError("ENOENT", "cp", src);
    if (node.type === "dir" && !options?.recursive) throw fsError("EISDIR", "cp", src);
    if (node.type === "dir" && isWithin(d, s)) throw fsError("EINVAL", "cp", dest);
    await this.copyTree(s, d, "cp");
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

  // --- internals -----------------------------------------------------------

  private key(path: string): string {
    return this.prefix + path.slice(1);
  }

  private dirKeyPrefix(dir: string): string {
    return dir === "/" ? this.prefix : `${this.key(dir)}/`;
  }

  private markerKey(dir: string): string {
    return this.dirKeyPrefix(dir) + DIR_MARKER;
  }

  /** Storage errors never reach the agent: no bucket names, keys or endpoints. */
  private async io<T>(syscall: string, path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw fsError("EIO", syscall, path);
    }
  }

  private reset(): void {
    this.nodes = new Map([["/", { type: "dir", mtime: new Date(), mode: DIR_MODE, marker: true }]]);
    this.children = new Map([["/", new Set()]]);
    this.cache.clear();
    this.cacheSize = 0;
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
  private async keepParent(path: string): Promise<void> {
    const parent = dirname(path);
    const node = this.nodes.get(parent);
    if (parent === "/" || node?.type !== "dir" || node.marker) return;
    if (this.children.get(parent)?.size) return;
    await this.io("rm", path, () => this.store.put(this.markerKey(parent), new Uint8Array()));
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

  private async copyTree(src: string, dest: string, syscall: string): Promise<void> {
    const node = this.nodes.get(src)!;
    if (node.type === "file") {
      this.assertWritableFile(dest, syscall);
      await this.copyFile(src, dest, node.mode, syscall);
      return;
    }
    if (!this.nodes.has(dest)) await this.mkdir(dest, { recursive: true });
    const entries = [...this.nodes].filter(([p]) => p !== src && isWithin(p, src));
    for (const [p, n] of entries) {
      if (n.type === "dir") await this.mkdir(dest + p.slice(src.length), { recursive: true });
    }
    await pool(
      entries.filter(([, n]) => n.type === "file"),
      COPY_CONCURRENCY,
      ([p, n]) => this.copyFile(p, dest + p.slice(src.length), n.mode, syscall),
    );
  }

  private async copyFile(src: string, dest: string, mode: number, syscall: string): Promise<void> {
    if (this.store.copy) {
      const info = await this.io(syscall, src, () => this.store.copy!(this.key(src), this.key(dest)));
      this.addFile(dest, info, mode);
      const hit = this.cached(src);
      if (hit) this.remember(dest, info.etag, hit.body);
      return;
    }
    const body = await this.readFileBuffer(src);
    const info = await this.io(syscall, dest, () => this.store.put(this.key(dest), body));
    this.addFile(dest, info, mode);
    this.remember(dest, info.etag, body);
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

  // LRU: Map keeps insertion order, so re-inserting on access moves to the end.
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
    this.cache.set(path, { etag, body: body.slice() });
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

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
