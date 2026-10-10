/**
 * The only thing krino needs from object storage. Keys are full object keys
 * (prefix included); the filesystem layer never leaks them to the agent.
 */
export interface ObjectStore {
  /** Every object under `prefix`, recursively. */
  list(prefix: string): AsyncIterable<ObjectInfo>;
  get(key: string): Promise<StoredObject | null>;
  /** Throws `PreconditionFailedError` when a condition doesn't hold. */
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<ObjectInfo>;
  delete(keys: string[]): Promise<void>;
  /** Server-side copy. Optional; krino falls back to get + put. */
  copy?(from: string, to: string): Promise<ObjectInfo>;
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  mtime: Date;
}

export interface StoredObject extends ObjectInfo {
  body: Uint8Array;
}

export interface PutOptions {
  /** Only write if the current object has this etag. */
  ifMatch?: string;
  /** Only write if no object exists at this key. */
  ifNoneMatch?: "*";
}

export class PreconditionFailedError extends Error {
  constructor() {
    super("precondition failed");
    this.name = "PreconditionFailedError";
  }
}

export function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/"/g, "");
}

/** In-process store for tests and local development. */
export function memoryStore(): ObjectStore & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  let version = 0;

  const info = ({ body: _body, ...rest }: StoredObject): ObjectInfo => rest;

  return {
    objects,
    async *list(prefix) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      for (const key of keys) yield info(objects.get(key)!);
    },
    async get(key) {
      const obj = objects.get(key);
      return obj ? { ...obj, body: obj.body.slice() } : null;
    },
    async put(key, body, options) {
      const existing = objects.get(key);
      if (options?.ifNoneMatch === "*" && existing) throw new PreconditionFailedError();
      if (options?.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
        throw new PreconditionFailedError();
      }
      const obj: StoredObject = {
        key,
        body: body.slice(),
        size: body.byteLength,
        etag: `v${++version}`,
        mtime: new Date(),
      };
      objects.set(key, obj);
      return info(obj);
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    async copy(from, to) {
      const src = objects.get(from);
      if (!src) throw new Error(`no such key: ${from}`);
      const obj = { ...src, key: to, etag: `v${++version}`, mtime: new Date() };
      objects.set(to, obj);
      return info(obj);
    },
  };
}
