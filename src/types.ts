import type { S3Client } from "@aws-sdk/client-s3";

export interface FilesystemConfig {
  /** S3/R2 bucket name */
  bucket: string;
  /** Optional key prefix — scopes all operations under this path */
  prefix?: string;
  /** Initial working directory (default: "/") */
  cwd?: string;

  // Credential shorthand (ignored if client is provided)

  /** Pre-configured S3Client — bypasses all credential/endpoint resolution */
  client?: S3Client;
  /** AWS region or "auto" for R2 */
  region?: string;
  /** Custom endpoint URL (e.g. R2, MinIO, LocalStack) */
  endpoint?: string;
  /** Access key ID. Falls back to S3FS_ACCESS_KEY_ID, then AWS_ACCESS_KEY_ID */
  accessKeyId?: string;
  /** Secret access key. Falls back to S3FS_SECRET_ACCESS_KEY, then AWS_SECRET_ACCESS_KEY */
  secretAccessKey?: string;
}

export interface ReadResult {
  content: string;
  etag: string;
  size: number;
  lastModified: Date;
}

export interface WriteOptions {
  /** ETag for optimistic locking — write fails with ConflictError if it doesn't match */
  ifMatch?: string;
  /** MIME type (default: "text/plain; charset=utf-8") */
  contentType?: string;
}

export interface WriteResult {
  etag: string;
}

export interface ListEntry {
  name: string;
  type: "file" | "directory";
  /** Size in bytes (files only) */
  size?: number;
  /** Last modified date (files only) */
  lastModified?: Date;
}

export interface ListOptions {
  /** Maximum items to return (default: 1000) */
  maxItems?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}
