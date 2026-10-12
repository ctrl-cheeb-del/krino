import { defineCommand, type CustomCommand, type ExecResult } from "just-bash";
import type { KrinoFs } from "./fs.js";
import { isWithin, resolve } from "./paths.js";

const CHUNK = 64 * 1024;
const NEWLINE = 10;

/**
 * `head -n` and `tail -n` that read only the start or end of a big stored
 * file instead of downloading all of it. Anything else (pipes, several files,
 * `-c`, `tail -f`, `+N`, small files) goes to just-bash's own command.
 */
export function rangeCommands(fs: KrinoFs, mountPoint: string, threshold: number): CustomCommand[] {
  const make = (name: "head" | "tail") =>
    defineCommand(name, async (args, ctx) => {
      const plan = parse(args);
      const orig = () => ctx.origCommand!(args);
      if (!plan) return orig();
      const abs = resolve(ctx.cwd, plan.file);
      if (!isWithin(abs, mountPoint)) return orig();
      const path = abs.slice(mountPoint.length) || "/";
      const stat = await fs.stat(path).catch(() => null);
      if (!stat?.isFile || stat.size < threshold) return orig();
      const bytes =
        name === "head" ? await head(fs, path, plan.lines) : await tail(fs, path, stat.size, plan.lines);
      return bytesOutput(bytes);
    });
  return [make("head"), make("tail")];
}

function parse(args: string[]): { lines: number; file: string } | null {
  let lines = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let n: string | undefined;
    if (a === "-n" || a === "--lines") n = args[++i];
    else if (a.startsWith("--lines=")) n = a.slice(8);
    else if (/^-n\d+$/.test(a)) n = a.slice(2);
    else if (/^-\d+$/.test(a)) n = a.slice(1);
    else if (a.startsWith("-") && a !== "-") return null;
    else files.push(a);
    if (n !== undefined) {
      if (!/^\d+$/.test(n)) return null;
      lines = Number(n);
    }
  }
  return files.length === 1 && files[0] !== "-" ? { lines, file: files[0]! } : null;
}

async function head(fs: KrinoFs, path: string, lines: number): Promise<Uint8Array> {
  if (lines === 0) return new Uint8Array();
  let buf: Uint8Array = new Uint8Array();
  for (let size = CHUNK; ; size *= 2) {
    const part = await fs.readRange(path, { offset: buf.length, length: size });
    buf = concat(buf, part);
    let seen = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === NEWLINE && ++seen === lines) return buf.slice(0, i + 1);
    }
    if (part.length < size) return buf;
  }
}

async function tail(fs: KrinoFs, path: string, total: number, lines: number): Promise<Uint8Array> {
  if (lines === 0) return new Uint8Array();
  for (let size = CHUNK; ; size *= 2) {
    const buf = await fs.readRange(path, { suffix: Math.min(size, total) });
    // A trailing newline ends the last line rather than starting a new one.
    const end = buf.length - (buf[buf.length - 1] === NEWLINE ? 1 : 0);
    let seen = 0;
    for (let i = end - 1; i >= 0; i--) {
      if (buf[i] === NEWLINE && ++seen === lines) return buf.slice(i + 1);
    }
    if (buf.length >= total) return buf;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function bytesOutput(bytes: Uint8Array): ExecResult {
  let stdout = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    stdout += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { stdout, stderr: "", exitCode: 0, stdoutKind: "bytes" };
}
