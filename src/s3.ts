import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { normalizeEtag, PreconditionFailedError, type ObjectStore } from "./store.js";

export interface S3StoreOptions {
  bucket: string;
  /** Pass a client, or config to build one. */
  client?: S3Client;
  config?: S3ClientConfig;
}

const isStatus = (err: unknown, ...codes: number[]) =>
  codes.includes((err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0);

/**
 * Store for any S3-compatible API: AWS S3, R2 over HTTP, MinIO, B2. Lives in
 * its own entry point (`krino/s3`) so Workers bundles never pull in the SDK.
 */
export function s3Store({ bucket, client, config }: S3StoreOptions): ObjectStore {
  const s3 =
    client ?? new S3Client({ forcePathStyle: Boolean(config?.endpoint), ...config });

  return {
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of page.Contents ?? []) {
          yield {
            key: o.Key!,
            size: o.Size ?? 0,
            etag: normalizeEtag(o.ETag ?? ""),
            mtime: o.LastModified ?? new Date(0),
          };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async get(key) {
      try {
        const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await o.Body!.transformToByteArray();
        return {
          key,
          body,
          size: body.byteLength,
          etag: normalizeEtag(o.ETag ?? ""),
          mtime: o.LastModified ?? new Date(),
        };
      } catch (err) {
        if (isStatus(err, 404)) return null;
        throw err;
      }
    },
    async put(key, body, options) {
      try {
        const o = await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            IfMatch: options?.ifMatch ? `"${options.ifMatch}"` : undefined,
            IfNoneMatch: options?.ifNoneMatch,
          }),
        );
        return { key, size: body.byteLength, etag: normalizeEtag(o.ETag ?? ""), mtime: new Date() };
      } catch (err) {
        if (isStatus(err, 412, 409)) throw new PreconditionFailedError();
        throw err;
      }
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
    async copy(from, to) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: to,
          CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: to }));
      return {
        key: to,
        size: head.ContentLength ?? 0,
        etag: normalizeEtag(head.ETag ?? ""),
        mtime: head.LastModified ?? new Date(),
      };
    },
  };
}
