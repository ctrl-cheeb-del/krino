import { createHash } from "crypto";

interface StoredObject {
  body: string;
  etag: string;
  lastModified: Date;
  contentType: string;
}

/**
 * In-memory S3-compatible store. Implements the S3Client.send() interface
 * for all commands used by Filesystem. No real S3/R2 needed.
 */
export class MemoryStore {
  private objects = new Map<string, StoredObject>();

  /** Pre-populate the store from a flat path→content map */
  seed(files: Record<string, string>): void {
    for (const [key, body] of Object.entries(files)) {
      this.objects.set(key, {
        body,
        etag: this.computeEtag(body),
        lastModified: new Date(),
        contentType: "text/plain; charset=utf-8",
      });
    }
  }

  /** Dump all keys (for debugging) */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** Read a key's content (for verification) */
  get(key: string): string | undefined {
    return this.objects.get(key)?.body;
  }

  /** Has a key? */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  private computeEtag(body: string): string {
    return createHash("md5").update(body).digest("hex");
  }

  /** S3Client-compatible send() — dispatches by command class name */
  send = async (command: any): Promise<any> => {
    const name = command.constructor.name;
    const input = command.input;

    switch (name) {
      case "GetObjectCommand":
        return this.handleGet(input);
      case "PutObjectCommand":
        return this.handlePut(input);
      case "DeleteObjectCommand":
        return this.handleDelete(input);
      case "DeleteObjectsCommand":
        return this.handleDeleteObjects(input);
      case "HeadObjectCommand":
        return this.handleHead(input);
      case "ListObjectsV2Command":
        return this.handleList(input);
      case "CopyObjectCommand":
        return this.handleCopy(input);
      default:
        throw new Error(`MemoryStore: unsupported command ${name}`);
    }
  };

  private handleGet(input: { Key: string }) {
    const obj = this.objects.get(input.Key);
    if (!obj) {
      const err = new Error(`NoSuchKey: ${input.Key}`);
      err.name = "NoSuchKey";
      throw err;
    }
    return {
      Body: { transformToString: async () => obj.body },
      ETag: `"${obj.etag}"`,
      ContentLength: obj.body.length,
      LastModified: obj.lastModified,
      ContentType: obj.contentType,
    };
  }

  private handlePut(input: { Key: string; Body: string; ContentType?: string; IfMatch?: string }) {
    if (input.IfMatch) {
      const existing = this.objects.get(input.Key);
      const expectedEtag = input.IfMatch.replace(/^"|"$/g, "");
      if (!existing || existing.etag !== expectedEtag) {
        const err = new Error("PreconditionFailed");
        err.name = "PreconditionFailed";
        throw err;
      }
    }

    const etag = this.computeEtag(input.Body ?? "");
    this.objects.set(input.Key, {
      body: input.Body ?? "",
      etag,
      lastModified: new Date(),
      contentType: input.ContentType ?? "text/plain; charset=utf-8",
    });
    return { ETag: `"${etag}"` };
  }

  private handleDelete(input: { Key: string }) {
    this.objects.delete(input.Key);
    return {};
  }

  private handleDeleteObjects(input: { Delete: { Objects: { Key: string }[] } }) {
    for (const obj of input.Delete.Objects) {
      this.objects.delete(obj.Key);
    }
    return {};
  }

  private handleHead(input: { Key: string }) {
    const obj = this.objects.get(input.Key);
    if (!obj) {
      const err = new Error("NotFound");
      err.name = "NotFound";
      throw err;
    }
    return {
      ETag: `"${obj.etag}"`,
      ContentLength: obj.body.length,
      LastModified: obj.lastModified,
      ContentType: obj.contentType,
    };
  }

  private handleList(input: {
    Prefix?: string;
    Delimiter?: string;
    MaxKeys?: number;
    ContinuationToken?: string;
  }) {
    const prefix = input.Prefix ?? "";
    const delimiter = input.Delimiter;
    const maxKeys = input.MaxKeys ?? 1000;

    // Get all keys matching prefix
    const allKeys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();

    // If there's a continuation token, skip keys before it
    const startIndex = input.ContinuationToken
      ? allKeys.findIndex((k) => k > input.ContinuationToken!)
      : 0;

    const relevantKeys = startIndex >= 0 ? allKeys.slice(startIndex) : [];

    if (!delimiter) {
      // No delimiter → flat listing
      const contents = relevantKeys.slice(0, maxKeys).map((key) => {
        const obj = this.objects.get(key)!;
        return {
          Key: key,
          Size: obj.body.length,
          LastModified: obj.lastModified,
          ETag: `"${obj.etag}"`,
        };
      });
      const isTruncated = relevantKeys.length > maxKeys;
      return {
        Contents: contents.length > 0 ? contents : undefined,
        IsTruncated: isTruncated,
        NextContinuationToken: isTruncated
          ? contents[contents.length - 1].Key
          : undefined,
      };
    }

    // With delimiter → group into Contents (files) and CommonPrefixes (dirs)
    const contents: any[] = [];
    const commonPrefixes = new Set<string>();
    let count = 0;

    for (const key of relevantKeys) {
      if (count >= maxKeys) break;

      const rest = key.slice(prefix.length);
      const delimIndex = rest.indexOf(delimiter);

      if (delimIndex === -1) {
        // No delimiter in remainder → it's a "file" at this level
        const obj = this.objects.get(key)!;
        contents.push({
          Key: key,
          Size: obj.body.length,
          LastModified: obj.lastModified,
          ETag: `"${obj.etag}"`,
        });
        count++;
      } else {
        // Has delimiter → it's under a "subdirectory"
        const dirPrefix = prefix + rest.slice(0, delimIndex + 1);
        if (!commonPrefixes.has(dirPrefix)) {
          commonPrefixes.add(dirPrefix);
          count++;
        }
      }
    }

    const allCount = relevantKeys.length;
    const processedCount = count;

    return {
      Contents: contents.length > 0 ? contents : undefined,
      CommonPrefixes:
        commonPrefixes.size > 0
          ? [...commonPrefixes].map((p) => ({ Prefix: p }))
          : undefined,
      IsTruncated: false, // simplification for eval
    };
  }

  private handleCopy(input: { Key: string; CopySource: string }) {
    // CopySource is "bucket/key" — strip the bucket prefix
    const sourceKey = input.CopySource.includes("/")
      ? input.CopySource.split("/").slice(1).join("/")
      : input.CopySource;

    const obj = this.objects.get(sourceKey);
    if (!obj) {
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    }

    this.objects.set(input.Key, { ...obj, lastModified: new Date() });
    return { CopyObjectResult: { ETag: `"${obj.etag}"` } };
  }
}
