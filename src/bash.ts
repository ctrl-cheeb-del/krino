import { Bash, InMemoryFs, MountableFs, type BashOptions } from "just-bash";
import { KrinoFs, type KrinoFsOptions } from "./fs.js";

export interface CreateBashOptions extends KrinoFsOptions {
  /** Where the stored files appear in the shell. Default `/workspace`. */
  mountPoint?: string;
  /** Passed through to just-bash (commands, env, limits, network...). */
  bash?: Omit<BashOptions, "fs" | "cwd" | "files">;
}

/**
 * A just-bash shell with stored files mounted at `/workspace` (the starting
 * directory). Everything else, `/tmp`, `/dev`, `/proc`, lives in memory and
 * disappears with the instance.
 */
export async function createBash(
  options: CreateBashOptions,
): Promise<{ bash: Bash; fs: KrinoFs }> {
  const { mountPoint = "/workspace", bash: bashOptions, ...fsOptions } = options;
  const fs = await KrinoFs.open(fsOptions);
  const base = new InMemoryFs();
  base.mkdirSync("/tmp", { recursive: true });
  const bash = new Bash({
    ...bashOptions,
    fs: new MountableFs({ base, mounts: [{ mountPoint, filesystem: fs }] }),
    cwd: mountPoint,
  });
  return { bash, fs };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute(input: { command: string }): Promise<string>;
}

const MAX_OUTPUT = 30_000;

/**
 * One `bash` tool for any agent framework. The output reads like a terminal,
 * with no mention of storage.
 */
export function bashTool(bash: Bash, options: { name?: string; description?: string } = {}): ToolDefinition {
  return {
    name: options.name ?? "bash",
    description:
      options.description ??
      "Run a bash command in the project directory. Supports common Unix tools (ls, cat, grep, find, sed, awk, jq, ...), pipes, redirects and heredocs.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run." } },
      required: ["command"],
    },
    async execute({ command }) {
      const { stdout, stderr, exitCode } = await bash.exec(command);
      let out = stdout + (stderr ? (stdout && !stdout.endsWith("\n") ? "\n" : "") + stderr : "");
      if (out.length > MAX_OUTPUT) {
        out = `${out.slice(0, MAX_OUTPUT)}\n[output truncated: ${out.length - MAX_OUTPUT} more characters]`;
      }
      if (exitCode !== 0) out += `${out && !out.endsWith("\n") ? "\n" : ""}[exit code ${exitCode}]`;
      return out;
    },
  };
}
