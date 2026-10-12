import {
  normalizeEtag,
  sliceRange,
  PreconditionFailedError,
  type ObjectInfo,
  type ObjectStore,
} from "./store.js";

/**
 * The slice of the Workers `R2Bucket` binding krino uses, typed structurally
 * so the package doesn't depend on @cloudflare/workers-types.
 */
export interface R2BucketLike {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } | { suffix: number } },
  ): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { onlyIf?: { etagMatches?: string } | Headers },
  ): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
}

interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

const toInfo = (o: R2ObjectLike): ObjectInfo => ({
  key: o.key,
  size: o.size,
  etag: normalizeEtag(o.etag),
  mtime: o.uploaded,
});

/** Store backed by a Cloudflare Workers R2 binding (`env.MY_BUCKET`). */
export function r2Store(bucket: R2BucketLike): ObjectStore {
  return {
    async *list(prefix) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const o of page.objects) yield toInfo(o);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      return { ...toInfo(o), body: new Uint8Array(await o.arrayBuffer()) };
    },
    async put(key, body, options) {
      if (options?.ifNoneMatch === "*") {
        const o = await bucket.put(key, body, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
        });
        if (!o) throw new PreconditionFailedError();
        return toInfo(o);
      }
      const o = await bucket.put(
        key,
        body,
        options?.ifMatch ? { onlyIf: { etagMatches: options.ifMatch } } : undefined,
      );
      if (!o) throw new PreconditionFailedError();
      return toInfo(o);
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await bucket.delete(keys.slice(i, i + 1000));
      }
    },
    async getRange(key, range) {
      const o = await bucket.get(key, { range });
      if (!o) return null;
      const body = new Uint8Array(await o.arrayBuffer());
      // Some runtimes ignore the range; trim so callers always get what they asked for.
      const trimmed = body.length === o.size && o.size > 0 ? sliceRange(body, range) : body;
      return { body: trimmed, size: o.size, etag: normalizeEtag(o.etag) };
    },
  };
}
