import type { Filesystem } from "./filesystem.js";
import type { ToolDefinition } from "./types.js";
import { NotFoundError, DirectoryNotEmptyError } from "./errors.js";

/**
 * Returns a single `run_command` tool that parses shell commands and
 * routes them through the Filesystem. The model can use natural bash
 * commands and never know it's hitting S3.
 */
export function getShellTool(fs: Filesystem): ToolDefinition {
  return {
    name: "run_command",
    description:
      "Run a shell command in the current working directory. " +
      "Supports: ls, cat, head, tail, grep, find, tree, wc, diff, sed, sort, uniq, " +
      "mkdir, rm, rmdir, mv, cp, touch, pwd, cd, echo. " +
      "Supports pipes (|), redirects (>), command chaining (&&, ;), and heredocs (<< EOF).",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run",
        },
      },
      required: ["command"],
    },
    execute: async (input) => {
      try {
        return await executeCommand(fs, input.command as string);
      } catch (err: unknown) {
        if (
          err instanceof NotFoundError ||
          err instanceof DirectoryNotEmptyError
        ) {
          return err.message;
        }
        return "Operation failed. Please try again.";
      }
    },
  };
}

// ─── command parser ────────────────────────────────────────

async function executeCommand(
  fs: Filesystem,
  raw: string,
  stdin?: string,
): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return stdin ?? "";

  // ── heredoc: cat > file << 'EOF' ... EOF  or  cat << EOF > file ──
  const heredocMatch = trimmed.match(
    /^cat\s+(?:>\s*(\S+)\s+)?<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\2\s*$/,
  );
  if (heredocMatch) {
    const target = heredocMatch[1];
    const content = heredocMatch[3];
    if (target) {
      await fs.writeFile(target, content + "\n");
      return "";
    }
    return content;
  }
  // Also: cat << EOF > file (redirect after heredoc marker)
  const heredocMatch2 = trimmed.match(
    /^cat\s+<<\s*'?(\w+)'?\s+>\s*(\S+)\s*\n([\s\S]*?)\n\1\s*$/,
  );
  if (heredocMatch2) {
    await fs.writeFile(heredocMatch2[2], heredocMatch2[3] + "\n");
    return "";
  }

  // ── && chaining ──
  if (trimmed.includes("&&") && !isInsideQuotes(trimmed, trimmed.indexOf("&&"))) {
    const parts = splitOutsideQuotes(trimmed, "&&");
    const results: string[] = [];
    for (const part of parts) {
      const result = await executeCommand(fs, part);
      if (result.startsWith("Error:") || result.endsWith("not found")) {
        return result;
      }
      if (result) results.push(result);
    }
    return results.join("\n");
  }

  // ── ; chaining ──
  if (trimmed.includes(";") && !isInsideQuotes(trimmed, trimmed.indexOf(";"))) {
    const parts = splitOutsideQuotes(trimmed, ";").filter(Boolean);
    const results: string[] = [];
    for (const part of parts) {
      try {
        const result = await executeCommand(fs, part);
        if (result) results.push(result);
      } catch {
        // ; continues regardless
      }
    }
    return results.join("\n");
  }

  // ── pipes (require space around |) ──
  if (/ \| /.test(trimmed) && !isInsideQuotes(trimmed, trimmed.search(/ \| /))) {
    const segments = splitOutsideQuotes(trimmed, " | ");
    if (segments.length > 1) {
      let data = stdin ?? "";
      for (const seg of segments) {
        data = await executeCommand(fs, seg, data);
      }
      return data;
    }
  }

  // ── output redirect: command > file ──
  const redirectMatch = trimmed.match(/^(.+?)\s*>\s*(\S+)\s*$/);
  if (redirectMatch && !trimmed.startsWith("echo ") && !trimmed.startsWith("cat >") && !trimmed.startsWith("cat\t>")) {
    const output = await executeCommand(fs, redirectMatch[1], stdin);
    await fs.writeFile(redirectMatch[2], output.endsWith("\n") ? output : output + "\n");
    return "";
  }

  // ── echo with redirect ──
  const echoRedirect = trimmed.match(
    /^echo\s+(?:"([^"]*)"|'([^']*)'|(.*?))\s*>\s*(.+)$/,
  );
  if (echoRedirect) {
    const content = echoRedirect[1] ?? echoRedirect[2] ?? echoRedirect[3] ?? "";
    await fs.writeFile(echoRedirect[4].trim(), content + "\n");
    return "";
  }

  // ── cat > file (interactive, not supported) ──
  if (/^cat\s*>\s*\S+$/.test(trimmed) && !stdin) {
    return "Error: interactive cat redirect not supported. Use heredoc (cat > file << EOF) or echo.";
  }

  // Parse tokens
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return stdin ?? "";

  const cmd = tokens[0];
  const args = tokens.slice(1);

  switch (cmd) {
    case "ls":       return cmdLs(fs, args);
    case "cat":      return cmdCat(fs, args, stdin);
    case "head":     return cmdHead(fs, args, stdin);
    case "tail":     return cmdTail(fs, args, stdin);
    case "mkdir":    return cmdMkdir(fs, args);
    case "rm":       return cmdRm(fs, args);
    case "rmdir":    return cmdRmdir(fs, args);
    case "mv":       return cmdMv(fs, args);
    case "cp":       return cmdCp(fs, args);
    case "touch":    return cmdTouch(fs, args);
    case "pwd":      return fs.cwd;
    case "cd":       return cmdCd(fs, args);
    case "wc":       return cmdWc(fs, args, stdin);
    case "find":     return cmdFind(fs, args);
    case "grep":     return cmdGrep(fs, args, stdin);
    case "tree":     return cmdTree(fs, args);
    case "sed":      return cmdSed(fs, args, stdin);
    case "diff":     return cmdDiff(fs, args);
    case "sort":     return cmdSort(args, stdin);
    case "uniq":     return cmdUniq(args, stdin);
    case "echo":     return args.join(" ");
    case "whoami":   return "user";
    case "which":    return args.length > 0 ? `/usr/bin/${args[0]}` : "";
    case "basename": return args.length > 0 ? args[0].split("/").pop() ?? "" : "";
    case "dirname":  return args.length > 0 ? args[0].split("/").slice(0, -1).join("/") || "/" : "";
    case "tee":      return cmdTee(fs, args, stdin);
    case "true":     return "";
    case "false":    return "";
    default:         return `${cmd}: command not found`;
  }
}

// ─── tokenizer ─────────────────────────────────────────────

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Check if a position in the string is inside single or double quotes */
function isInsideQuotes(s: string, pos: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < pos; i++) {
    if (s[i] === "'" && !inDouble) inSingle = !inSingle;
    if (s[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

/** Split on a delimiter, but only outside quotes */
function splitOutsideQuotes(s: string, delim: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'" && !inDouble) { inSingle = !inSingle; current += s[i]; continue; }
    if (s[i] === '"' && !inSingle) { inDouble = !inDouble; current += s[i]; continue; }
    if (!inSingle && !inDouble && s.slice(i, i + delim.length) === delim) {
      parts.push(current.trim());
      current = "";
      i += delim.length - 1;
      continue;
    }
    current += s[i];
  }
  parts.push(current.trim());
  return parts;
}

// ─── flag parsing ──────────────────────────────────────────

function parseFlags(args: string[]): { flags: Set<string>; operands: string[] } {
  const flags = new Set<string>();
  const operands: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      for (const ch of arg.slice(1)) flags.add(ch);
    } else if (arg.startsWith("--")) {
      flags.add(arg.slice(2));
    } else {
      operands.push(arg);
    }
  }
  return { flags, operands };
}

/** Parse args with numeric value flags like -A 3, -B 2, -C 1, -n 10 */
function parseNumericFlags(args: string[], flagNames: string[]): {
  flags: Set<string>;
  numericFlags: Record<string, number>;
  operands: string[];
} {
  const flags = new Set<string>();
  const numericFlags: Record<string, number> = {};
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-") && arg.length === 2 && flagNames.includes(arg[1])) {
      if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        numericFlags[arg[1]] = parseInt(args[i + 1], 10);
        i++;
      } else {
        flags.add(arg[1]);
      }
    } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      for (const ch of arg.slice(1)) flags.add(ch);
    } else if (arg.startsWith("--")) {
      flags.add(arg.slice(2));
    } else {
      operands.push(arg);
    }
  }
  return { flags, numericFlags, operands };
}

function parseHeadTailArgs(args: string[]): { n: number; files: string[] } {
  let n = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      n = parseInt(args[i + 1], 10); i++;
    } else if (args[i].match(/^-\d+$/)) {
      n = parseInt(args[i].slice(1), 10);
    } else if (!args[i].startsWith("-")) {
      files.push(args[i]);
    }
  }
  return { n, files };
}

// ─── commands ──────────────────────────────────────────────

async function cmdLs(fs: Filesystem, args: string[]): Promise<string> {
  const { flags, operands } = parseFlags(args);
  const path = operands[0];
  const long = flags.has("l");
  const entries = await fs.listDir(path);
  if (entries.length === 0) return "";
  if (long) {
    return entries.map((e) => {
      const size = e.size != null ? String(e.size).padStart(8) : "       0";
      const date = e.lastModified ? e.lastModified.toISOString().slice(0, 10) : "          ";
      const name = e.type === "directory" ? e.name + "/" : e.name;
      const perm = e.type === "directory" ? "drwxr-xr-x" : "-rw-r--r--";
      return `${perm}  1 user user ${size} ${date} ${name}`;
    }).join("\n");
  }
  return entries.map((e) => (e.type === "directory" ? e.name + "/" : e.name)).join("  ");
}

async function cmdCat(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  if (args.length === 0) {
    return stdin ?? "cat: missing operand";
  }
  const results: string[] = [];
  for (const path of args) {
    if (path.startsWith("-")) continue;
    const { content } = await fs.readFile(path);
    results.push(content);
  }
  return results.join("\n");
}

async function cmdHead(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  const { n, files } = parseHeadTailArgs(args);
  if (files.length === 0 && stdin != null) {
    return stdin.split("\n").slice(0, n).join("\n");
  }
  if (files.length === 0) return "head: missing operand";
  const { content } = await fs.readFile(files[0]);
  return content.split("\n").slice(0, n).join("\n");
}

async function cmdTail(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  const { n, files } = parseHeadTailArgs(args);
  if (files.length === 0 && stdin != null) {
    return stdin.split("\n").slice(-n).join("\n");
  }
  if (files.length === 0) return "tail: missing operand";
  const { content } = await fs.readFile(files[0]);
  return content.split("\n").slice(-n).join("\n");
}

async function cmdMkdir(fs: Filesystem, args: string[]): Promise<string> {
  const { operands } = parseFlags(args);
  if (operands.length === 0) return "mkdir: missing operand";
  for (const dir of operands) await fs.mkdir(dir);
  return "";
}

async function cmdRm(fs: Filesystem, args: string[]): Promise<string> {
  const { flags, operands } = parseFlags(args);
  const recursive = flags.has("r") || flags.has("R");
  const force = flags.has("f");
  if (operands.length === 0) return "rm: missing operand";
  for (const target of operands) {
    try {
      if (recursive) { try { await fs.rmdir(target, true); continue; } catch {} }
      await fs.deleteFile(target);
    } catch (err) { if (!force) throw err; }
  }
  return "";
}

async function cmdRmdir(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  if (operands.length === 0) return "rmdir: missing operand";
  for (const dir of operands) await fs.rmdir(dir);
  return "";
}

async function cmdMv(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  if (operands.length < 2) return "mv: missing operand";
  await fs.move(operands[0], operands[1]);
  return "";
}

async function cmdCp(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  if (operands.length < 2) return "cp: missing operand";
  const { content } = await fs.readFile(operands[0]);
  await fs.writeFile(operands[1], content);
  return "";
}

async function cmdTouch(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  if (operands.length === 0) return "touch: missing operand";
  for (const path of operands) {
    if (!(await fs.exists(path))) await fs.writeFile(path, "");
  }
  return "";
}

async function cmdCd(fs: Filesystem, args: string[]): Promise<string> {
  fs.cd(args[0] ?? "/");
  return "";
}

async function cmdWc(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  const { flags, operands } = parseFlags(args);

  const sources: { content: string; label: string }[] = [];
  if (operands.length > 0) {
    for (const path of operands) {
      const { content } = await fs.readFile(path);
      sources.push({ content, label: path });
    }
  } else if (stdin != null) {
    sources.push({ content: stdin, label: "" });
  } else {
    return "wc: missing operand";
  }

  return sources.map(({ content, label }) => {
    const lines = content.split("\n").length;
    const words = content.split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(content).length;
    const name = label ? ` ${label}` : "";
    if (flags.has("l")) return `${String(lines).padStart(8)}${name}`;
    if (flags.has("w")) return `${String(words).padStart(8)}${name}`;
    if (flags.has("c")) return `${String(bytes).padStart(8)}${name}`;
    return `${String(lines).padStart(8)}${String(words).padStart(8)}${String(bytes).padStart(8)}${name}`;
  }).join("\n");
}

async function cmdFind(fs: Filesystem, args: string[]): Promise<string> {
  let startPath = ".";
  let namePattern: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-name" && i + 1 < args.length) { namePattern = args[i + 1]; i++; }
    else if (!args[i].startsWith("-")) { startPath = args[i]; }
  }
  const results: string[] = [];
  await findRecursive(fs, startPath, namePattern, results);
  return results.join("\n");
}

async function findRecursive(
  fs: Filesystem, dir: string, pattern: string | undefined,
  results: string[], depth = 0,
): Promise<void> {
  if (depth > 10) return;
  const entries = await fs.listDir(dir);
  for (const entry of entries) {
    const fullPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (!pattern || matchGlob(entry.name, pattern)) results.push(fullPath);
    if (entry.type === "directory") {
      await findRecursive(fs, fullPath, pattern, results, depth + 1);
    }
  }
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
  );
  return regex.test(name);
}

async function cmdGrep(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  const { flags, numericFlags, operands } = parseNumericFlags(args, ["A", "B", "C"]);
  const recursive = flags.has("r") || flags.has("R");
  const ignoreCase = flags.has("i");
  const lineNumbers = flags.has("n");
  const afterCtx = numericFlags["A"] ?? numericFlags["C"] ?? 0;
  const beforeCtx = numericFlags["B"] ?? numericFlags["C"] ?? 0;

  if (operands.length < 1) return "grep: missing pattern";

  const pattern = operands[0];
  const targets = operands.slice(1);
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");

  // Grep from stdin
  if (stdin != null && targets.length === 0 && !recursive) {
    return grepLines(stdin.split("\n"), regex, lineNumbers, "", beforeCtx, afterCtx);
  }

  if (targets.length === 0 && !recursive) return "grep: missing file operand";

  const filesToSearch: { path: string; prefix: string }[] = [];
  if (recursive) {
    const searchDir = targets[0] ?? ".";
    const allFiles: string[] = [];
    await findRecursive(fs, searchDir, undefined, allFiles);
    for (const f of allFiles) {
      const name = f.split("/").pop() ?? "";
      if (name.includes(".")) filesToSearch.push({ path: f, prefix: f + ":" });
    }
  } else {
    const multi = targets.length > 1;
    for (const t of targets) {
      filesToSearch.push({ path: t, prefix: multi ? t + ":" : "" });
    }
  }

  const results: string[] = [];
  for (const { path, prefix } of filesToSearch) {
    try {
      const { content } = await fs.readFile(path);
      const out = grepLines(content.split("\n"), regex, lineNumbers, prefix, beforeCtx, afterCtx);
      if (out) results.push(out);
    } catch { /* skip unreadable */ }
  }
  return results.join("\n");
}

function grepLines(
  lines: string[], regex: RegExp, showLineNums: boolean,
  prefix: string, before: number, after: number,
): string {
  const results: string[] = [];
  const printed = new Set<number>();
  let lastPrintedGroup = -2;

  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;

    const start = Math.max(0, i - before);
    const end = Math.min(lines.length - 1, i + after);

    if ((before > 0 || after > 0) && results.length > 0 && start > lastPrintedGroup + 1) {
      results.push("--"); // group separator
    }

    for (let j = start; j <= end; j++) {
      if (printed.has(j)) continue;
      printed.add(j);
      const ln = showLineNums ? `${j + 1}:` : "";
      results.push(`${prefix}${ln}${lines[j]}`);
      lastPrintedGroup = j;
    }
  }
  return results.join("\n");
}

async function cmdSed(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  let inPlace = false;
  let expression = "";
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-i") { inPlace = true; continue; }
    if (args[i] === "-e" && i + 1 < args.length) { expression = args[++i]; continue; }
    if (!expression && args[i].startsWith("s") && args[i].length > 3) {
      expression = args[i];
    } else if (!args[i].startsWith("-")) {
      files.push(args[i]);
    }
  }

  if (!expression) return "sed: missing expression";

  // Parse s/pattern/replacement/flags
  const sedMatch = expression.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
  if (!sedMatch) return `sed: invalid expression: ${expression}`;

  const [, , sedPattern, replacement, sedFlags] = sedMatch;
  const globalReplace = sedFlags.includes("g");
  const caseInsensitive = sedFlags.includes("i");
  const re = new RegExp(sedPattern, (globalReplace ? "g" : "") + (caseInsensitive ? "i" : ""));

  const apply = (text: string) => text.split("\n").map((line) => line.replace(re, replacement)).join("\n");

  // From stdin
  if (stdin != null && files.length === 0) {
    return apply(stdin);
  }

  if (files.length === 0) return "sed: missing file operand";

  const results: string[] = [];
  for (const path of files) {
    const { content } = await fs.readFile(path);
    const transformed = apply(content);
    if (inPlace) {
      await fs.writeFile(path, transformed);
    } else {
      results.push(transformed);
    }
  }
  return inPlace ? "" : results.join("\n");
}

async function cmdDiff(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  if (operands.length < 2) return "diff: missing operand";

  const { content: a } = await fs.readFile(operands[0]);
  const { content: b } = await fs.readFile(operands[1]);

  if (a === b) return "";

  // Simple line-by-line diff
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const results: string[] = [];
  results.push(`--- ${operands[0]}`);
  results.push(`+++ ${operands[1]}`);

  const maxLen = Math.max(aLines.length, bLines.length);
  let inHunk = false;

  for (let i = 0; i < maxLen; i++) {
    const aLine = aLines[i];
    const bLine = bLines[i];
    if (aLine === bLine) {
      if (inHunk) { results.push(` ${aLine ?? ""}`); }
      continue;
    }
    if (!inHunk) {
      results.push(`@@ -${i + 1} +${i + 1} @@`);
      inHunk = true;
    }
    if (aLine != null && bLine != null) {
      results.push(`-${aLine}`);
      results.push(`+${bLine}`);
    } else if (aLine != null) {
      results.push(`-${aLine}`);
    } else if (bLine != null) {
      results.push(`+${bLine}`);
    }
  }
  return results.join("\n");
}

function cmdSort(args: string[], stdin?: string): string {
  const { flags } = parseFlags(args);
  const reverse = flags.has("r");
  const numeric = flags.has("n");
  const unique = flags.has("u");

  const text = stdin ?? "";
  if (!text) return "";

  let lines = text.split("\n");
  if (unique) lines = [...new Set(lines)];

  lines.sort((a, b) => {
    if (numeric) return parseFloat(a) - parseFloat(b);
    return a.localeCompare(b);
  });
  if (reverse) lines.reverse();
  return lines.join("\n");
}

function cmdUniq(args: string[], stdin?: string): string {
  const { flags } = parseFlags(args);
  const count = flags.has("c");

  const text = stdin ?? "";
  if (!text) return "";

  const lines = text.split("\n");
  const results: string[] = [];
  let prev: string | undefined;
  let cnt = 0;

  for (const line of lines) {
    if (line === prev) {
      cnt++;
    } else {
      if (prev != null) {
        results.push(count ? `${String(cnt).padStart(7)} ${prev}` : prev);
      }
      prev = line;
      cnt = 1;
    }
  }
  if (prev != null) {
    results.push(count ? `${String(cnt).padStart(7)} ${prev}` : prev);
  }
  return results.join("\n");
}

async function cmdTee(fs: Filesystem, args: string[], stdin?: string): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  const text = stdin ?? "";
  for (const path of operands) {
    await fs.writeFile(path, text);
  }
  return text;
}

async function cmdTree(fs: Filesystem, args: string[]): Promise<string> {
  const operands = args.filter((a) => !a.startsWith("-"));
  const startPath = operands[0] ?? ".";
  const lines: string[] = [startPath === "." ? "." : startPath];
  let dirs = 0;
  let files = 0;
  await treeRecursive(fs, startPath, "", lines, (d, f) => { dirs += d; files += f; });
  lines.push("");
  lines.push(`${dirs} directories, ${files} files`);
  return lines.join("\n");
}

async function treeRecursive(
  fs: Filesystem, dir: string, prefix: string, lines: string[],
  count: (dirs: number, files: number) => void, depth = 0,
): Promise<void> {
  if (depth > 8) return;
  const entries = await fs.listDir(dir);
  let localDirs = 0;
  let localFiles = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const name = entry.type === "directory" ? entry.name + "/" : entry.name;
    lines.push(prefix + connector + name);
    if (entry.type === "directory") {
      localDirs++;
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const fullPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
      await treeRecursive(fs, fullPath, childPrefix, lines, count, depth + 1);
    } else {
      localFiles++;
    }
  }
  count(localDirs, localFiles);
}
