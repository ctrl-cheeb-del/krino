import { Bash, InMemoryFs, MountableFs, type BashOptions } from "just-bash";
import { KrinoFs, type KrinoFsOptions } from "./fs.js";

export interface CreateBashOptions extends Omit<KrinoFsOptions, "writeBehind"> {
  /** Where the stored files appear in the shell. Default `/workspace`. */
  mountPoint?: string;
  /** Passed through to just-bash (commands, env, limits, network...). */
  bash?: Omit<BashOptions, "fs" | "cwd" | "files">;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A shell session over stored files. Like a terminal, `cd` and `export`
 * carry over between `exec` calls; every call saves its writes before it
 * returns.
 */
export interface Session {
  exec(command: string): Promise<ExecResult>;
  /** A ready-made `bash` tool for agent frameworks. */
  tool(options?: ToolOptions): ToolDefinition;
  /** Current working directory. */
  readonly cwd: string;
  readonly bash: Bash;
  readonly fs: KrinoFs;
}

/**
 * Open a session: stored files at `/workspace` (the starting directory);
 * `/tmp`, `/dev` and `/proc` live in memory for the session's lifetime.
 */
export async function createBash(options: CreateBashOptions): Promise<Session> {
  const { mountPoint = "/workspace", bash: bashOptions, ...fsOptions } = options;
  const fs = await KrinoFs.open({ ...fsOptions, writeBehind: true });
  const base = new InMemoryFs();
  base.mkdirSync("/tmp", { recursive: true });
  const bash = new Bash({
    ...bashOptions,
    fs: new MountableFs({ base, mounts: [{ mountPoint, filesystem: fs }] }),
    cwd: mountPoint,
  });

  let cwd = mountPoint;
  let env: Record<string, string> | undefined;
  let queue = Promise.resolve();

  const run = async (command: string): Promise<ExecResult> => {
    const result = await bash.exec(command, { cwd, env: env && { ...env, PWD: cwd } });
    let { stdout, stderr, exitCode } = result;
    try {
      await fs.flush();
    } catch {
      stderr += "bash: write error: Input/output error (changes will be retried)\n";
      exitCode ||= 1;
    }
    env = result.env;
    const next = result.env.PWD ?? cwd;
    cwd = (await bash.fs.exists(next)) ? next : mountPoint;
    return { stdout, stderr, exitCode };
  };

  const session: Session = {
    // One command at a time, like a terminal; overlapping calls queue up.
    exec(command) {
      const result = queue.then(() => run(command));
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    tool: (toolOptions) => bashTool(session, toolOptions),
    get cwd() {
      return cwd;
    },
    bash,
    fs,
  };
  return session;
}

export interface ToolOptions {
  name?: string;
  description?: string;
  /** Characters of output returned to the model. Default 30,000. */
  maxOutput?: number;
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

const DESCRIPTION = `Run a bash command. Works like a normal terminal: cd and exported variables carry over between calls.
Files under /workspace (the starting directory) are saved; /tmp is scratch space.
Supports common Unix tools (ls, cat, grep, find, sed, awk, jq, sort, diff, ...), pipes, redirects, heredocs, loops and functions. Programs like node, npm and python's pip are not available.`;

/**
 * One `bash` tool for any agent framework. Output reads like a terminal,
 * with no mention of storage. Long output keeps its start and its end,
 * where errors usually are.
 */
export function bashTool(
  target: Pick<Session, "exec"> | Bash,
  options: ToolOptions = {},
): ToolDefinition {
  const max = options.maxOutput ?? 30_000;
  return {
    name: options.name ?? "bash",
    description: options.description ?? DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run." } },
      required: ["command"],
    },
    async execute({ command }) {
      const { stdout, stderr, exitCode } = await target.exec(command);
      let out = stdout;
      if (stderr) out += (out && !out.endsWith("\n") ? "\n" : "") + stderr;
      if (out.length > max) {
        const head = out.slice(0, Math.floor(max * 0.6));
        const tail = out.slice(out.length - Math.floor(max * 0.4));
        out = `${head}\n[... ${out.length - head.length - tail.length} characters omitted ...]\n${tail}`;
      }
      if (exitCode !== 0) out += `${out && !out.endsWith("\n") ? "\n" : ""}[exit code ${exitCode}]`;
      return out || "(no output)";
    },
  };
}
