import type { BufferEncoding, FileContent } from "just-bash";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodingOf(
  options?: { encoding?: BufferEncoding | null } | BufferEncoding | null,
): BufferEncoding {
  if (typeof options === "string") return options;
  return options?.encoding ?? "utf8";
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export function toBytes(content: FileContent, encoding: BufferEncoding = "utf8"): Uint8Array {
  if (content instanceof Uint8Array) return content;
  switch (encoding) {
    case "base64":
      return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    case "hex": {
      const out = new Uint8Array(content.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(content.substr(i * 2, 2), 16);
      return out;
    }
    case "latin1":
    case "binary":
    case "ascii":
      return Uint8Array.from(content, (c) => c.charCodeAt(0) & 0xff);
    default:
      return encoder.encode(content);
  }
}

export function fromBytes(bytes: Uint8Array, encoding: BufferEncoding = "utf8"): string {
  switch (encoding) {
    case "base64":
      return btoa(latin1(bytes));
    case "hex":
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    case "latin1":
    case "binary":
      return latin1(bytes);
    case "ascii":
      return latin1(bytes.map((b) => b & 0x7f));
    default:
      return decoder.decode(bytes);
  }
}
