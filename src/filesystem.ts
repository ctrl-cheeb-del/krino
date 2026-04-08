import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  FilesystemConfig,
  ReadResult,
  WriteOptions,
  WriteResult,
  ListEntry,
  ListOptions,
} from "./types.js";
import { ConflictError, NotFoundError, DirectoryNotEmptyError } from "./errors.js";
import { resolvePath, toDisplayPath } from "./paths.js";

function isNotFound(err: Error): boolean {
  return err.name === "NotFound" || err.name === "NoSuchKey" || err.name === "404";
}

function stripETagQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

function ensureETagQuotes(etag: string): string {
  if (etag.startsWith('"') && etag.endsWith('"')) return etag;
  return `"${etag}"`;
}

export class Filesystem {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private _cwd: string;

  constructor(config: FilesystemConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix?.replace(/\/+$/, "") ?? "";
    this._cwd = config.cwd ?? "/";

    if (config.client) {
      this.client = config.client;
    } else {
      const endpoint =
        config.endpoint ?? process.env.S3FS_ENDPOINT ?? undefined;
      this.client = new S3Client({
        region:
          config.region ??
          process.env.S3FS_REGION ??
          process.env.AWS_REGION ??
          "auto",
        endpoint,
        forcePathStyle: !!endpoint,
        credentials: {
          accessKeyId:
            config.accessKeyId ??
            process.env.S3FS_ACCESS_KEY_ID ??
            process.env.AWS_ACCESS_KEY_ID ??
            "",
          secretAccessKey:
            config.secretAccessKey ??
            process.env.S3FS_SECRET_ACCESS_KEY ??
            process.env.AWS_SECRET_ACCESS_KEY ??
            "",
        },
      });
    }
  }

  get cwd(): string {
    return this._cwd;
  }

  cd(path: string): void {
    const resolved = resolvePath(this._cwd, path, "");
    this._cwd = "/" + resolved;
  }

  private key(path: string): string {
    return resolvePath(this._cwd, path, this.prefix);
  }

  private displayPath(s3Key: string): string {
    return toDisplayPath(s3Key, this.prefix);
  }

  async readFile(path: string): Promise<ReadResult> {
    const k = this.key(path);
    if (k.endsWith("/.keep") || k === ".keep") {
      throw new NotFoundError(this.displayPath(k));
    }
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: k }),
      );
      const content = (await res.Body?.transformToString()) ?? "";
      return {
        content,
        etag: stripETagQuotes(res.ETag ?? ""),
        size: res.ContentLength ?? 0,
        lastModified: res.LastModified ?? new Date(0),
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "NoSuchKey") {
        throw new NotFoundError(this.displayPath(k));
      }
      throw err;
    }
  }

  async writeFile(
    path: string,
    content: string,
    options?: WriteOptions,
  ): Promise<WriteResult> {
    const k = this.key(path);
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: k,
          Body: content,
          ContentType: options?.contentType ?? "text/plain; charset=utf-8",
          ...(options?.ifMatch
            ? { IfMatch: ensureETagQuotes(options.ifMatch) }
            : {}),
        }),
      );
      return { etag: stripETagQuotes(res.ETag ?? "") };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "PreconditionFailed") {
        throw new ConflictError(this.displayPath(k));
      }
      throw err;
    }
  }

  async deleteFile(path: string): Promise<void> {
    const k = this.key(path);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: k }),
    );
  }

  async exists(path: string): Promise<boolean> {
    const k = this.key(path);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: k }),
      );
      return true;
    } catch (err: unknown) {
      if (!(err instanceof Error) || !isNotFound(err)) throw err;
      // File not found — check for directory sentinel
      try {
        await this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket,
            Key: k + (k.endsWith("/") ? ".keep" : "/.keep"),
          }),
        );
        return true;
      } catch (err2: unknown) {
        if (!(err2 instanceof Error) || !isNotFound(err2)) throw err2;
        return false;
      }
    }
  }

  async listDir(path?: string, options?: ListOptions): Promise<ListEntry[]> {
    const k = path !== undefined ? this.key(path) : this.key(".");
    const dirPrefix = k ? k + "/" : "";
    const maxItems = options?.maxItems ?? 1000;
    const entries: ListEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: dirPrefix,
          Delimiter: "/",
          MaxKeys: Math.min(maxItems - entries.length, 1000),
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of res.Contents ?? []) {
        const name = obj.Key!.slice(dirPrefix.length);
        if (name === ".keep" || !name) continue;
        entries.push({
          name,
          type: "file",
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }

      for (const cp of res.CommonPrefixes ?? []) {
        const name = cp.Prefix!.slice(dirPrefix.length).replace(/\/$/, "");
        if (name) {
          entries.push({ name, type: "directory" });
        }
      }

      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken && entries.length < maxItems);

    return entries;
  }

  async mkdir(path: string): Promise<void> {
    const k = this.key(path);
    const sentinel = k + (k.endsWith("/") ? ".keep" : "/.keep");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sentinel,
        Body: "",
        ContentType: "application/x-empty",
      }),
    );
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    const k = this.key(path);
    const dirPrefix = k ? k + "/" : "";

    if (!recursive) {
      // Check directory has only the .keep sentinel (or nothing)
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: dirPrefix,
          MaxKeys: 2,
        }),
      );
      const objects = res.Contents ?? [];
      const nonSentinel = objects.filter(
        (o) => o.Key !== dirPrefix + ".keep",
      );
      if (nonSentinel.length > 0) {
        throw new DirectoryNotEmptyError(this.displayPath(k));
      }
      // Delete the sentinel if it exists
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: dirPrefix + ".keep",
          }),
        );
      }
    } else {
      // Recursive: list all objects under prefix and batch delete
      let continuationToken: string | undefined;
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: dirPrefix,
            ContinuationToken: continuationToken,
          }),
        );
        const objects = res.Contents ?? [];
        if (objects.length > 0) {
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: {
                Objects: objects.map((o) => ({ Key: o.Key! })),
                Quiet: true,
              },
            }),
          );
        }
        continuationToken = res.IsTruncated
          ? res.NextContinuationToken
          : undefined;
      } while (continuationToken);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const srcKey = this.key(from);
    const destKey = this.key(to);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destKey,
          CopySource: `${this.bucket}/${srcKey}`,
        }),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "NoSuchKey") {
        throw new NotFoundError(this.displayPath(srcKey));
      }
      throw err;
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: srcKey }),
    );
  }
}
