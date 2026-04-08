/**
 * Resolve a user-facing path to an S3 key.
 *
 * - Absolute paths (starting with `/`) ignore cwd.
 * - Relative paths are joined with cwd.
 * - `.` and `..` segments are normalized; `..` clamps at root.
 * - The prefix is prepended. The result never starts with `/`.
 */
export function resolvePath(
  cwd: string,
  inputPath: string,
  prefix: string,
): string {
  const absolute = inputPath.startsWith("/") ? inputPath : cwd + "/" + inputPath;
  const parts = absolute.split("/").filter(Boolean);

  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const normalizedPrefix = prefix ? prefix.replace(/\/+$/, "") + "/" : "";
  const tail = resolved.join("/");
  return tail ? normalizedPrefix + tail : normalizedPrefix.replace(/\/$/, "");
}

/**
 * Convert an S3 key back to a user-facing display path (for error messages).
 */
export function toDisplayPath(s3Key: string, prefix: string): string {
  const normalizedPrefix = prefix ? prefix.replace(/\/+$/, "") + "/" : "";
  let stripped: string;
  if (normalizedPrefix && s3Key === normalizedPrefix.replace(/\/$/, "")) {
    stripped = "";
  } else if (s3Key.startsWith(normalizedPrefix)) {
    stripped = s3Key.slice(normalizedPrefix.length);
  } else {
    stripped = s3Key;
  }
  return "/" + stripped;
}
