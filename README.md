# s3fs-agent

> This entire project — every line of code, every test, every eval — was written by Claude. A human had the idea and guided the direction. Claude did the rest.

A virtual filesystem for AI agents, backed by S3/R2. No VMs. No containers. No sandboxes. No persistent compute. Just an S3 bucket.

Your agent thinks it's in a normal development environment. It runs `ls`, `cat`, `grep`, `cd` — or uses `read_file`, `write_file`, `list_directory` tools. Under the hood, every operation is an S3 API call. Between tool calls, nothing is running. The agent never sees S3 keys, ETags, buckets, or credentials.

## Why

Every current approach to giving an AI agent filesystem access requires spinning up a VM or container (E2B, Daytona, etc). You pay for compute while the agent is waiting for an LLM response — which is ~90% of the time.

s3fs-agent skips all of that. Your "filesystem" is just S3 keys arranged to look like paths, and a thin translation layer that converts filesystem operations into S3 API calls. Cost: fractions of a penny per 1,000 file operations. No startup latency. No fleet management. No idle compute.

**The tradeoff:** agents can read and write files, but can't execute code (`npm install`, `node`, `python` return "command not found"). If your agent needs to run programs, you still need a real sandbox. If it just needs to navigate, read, edit, and create files — this is all you need.

## Install

```bash
npm install s3fs-agent
```

Single runtime dependency: `@aws-sdk/client-s3`.

## Quick Start

```typescript
import { Filesystem, getTools, getShellTool } from "s3fs-agent";

const fs = new Filesystem({
  bucket: "my-agent-data",
  prefix: "sessions/abc123",  // isolate each agent
});

// Option 1: Filesystem tools (read_file, write_file, list_directory, etc.)
const tools = getTools(fs);

// Option 2: Shell tool (ls, cat, grep, sed, etc.)
const shell = getShellTool(fs);

// Option 3: Both — the agent uses whichever feels natural
const allTools = [...getTools(fs), getShellTool(fs)];
```

### What the agent sees

**With filesystem tools:**
```
Tool: read_file({ path: "/src/app/page.tsx" })
→ "import { Header } from '@/components/header';\n..."

Tool: write_file({ path: "/src/app/page.tsx", content: "..." })
→ "File written successfully."

Tool: list_directory({ path: "/src" })
→ "app/\ncomponents/\nlib/"
```

**With the shell tool:**
```
Tool: run_command({ command: "ls -la src/" })
→ "-rw-r--r--  1 user user     2847 2025-01-15 page.tsx\ndrwxr-xr-x  1 user user ..."

Tool: run_command({ command: "cat src/app/page.tsx" })
→ "import { Header } from '@/components/header';\n..."

Tool: run_command({ command: "grep -rn 'import' src/ | head -5" })
→ "src/app/page.tsx:1:import { Header }..."

Tool: run_command({ command: "sed -i 's/$29/$49/g' src/components/pricing.tsx" })
→ ""
```

No ETags. No JSON wrappers. No S3 concepts. The agent doesn't know.

## Supported Shell Commands

The `run_command` tool supports everything a model would try in a locked-down container:

| Command | What works |
|---------|-----------|
| `ls`, `ls -la` | List files and directories |
| `cat` | Read one or more files |
| `head -n 20`, `tail -n 10` | First/last N lines |
| `grep -rin`, `grep -A 5 -B 2` | Search with regex, context lines, recursive |
| `find . -name "*.tsx"` | Find files by glob pattern |
| `tree` | Directory tree with connectors |
| `sed 's/old/new/g'`, `sed -i` | Find and replace, in-place editing |
| `diff file1 file2` | Compare two files |
| `wc -l`, `wc -w`, `wc -c` | Count lines/words/bytes |
| `mkdir -p`, `rm -rf`, `mv`, `cp` | File/directory operations |
| `touch`, `pwd`, `cd` | Create files, navigate |
| `echo "content" > file` | Write to file |
| `cat > file << EOF` | Heredoc (multi-line write) |
| `sort`, `sort -rn`, `uniq -c` | Sort and deduplicate |
| `tee`, `basename`, `dirname` | Utilities |
| `cmd1 \| cmd2 \| cmd3` | Pipes |
| `cmd1 && cmd2`, `cmd1; cmd2` | Chaining |
| `cmd > file` | Output redirect |
| `npm`, `node`, `python`, etc. | "command not found" (like a locked-down container) |

## Agent Framework Integration

`getTools(fs)` returns `{ name, description, inputSchema, execute }[]`. Framework-agnostic — adapt to anything:

### Anthropic API

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { Filesystem, getTools, getShellTool } from "s3fs-agent";

const anthropic = new Anthropic();
const fs = new Filesystem({ bucket: "my-bucket", prefix: "agent/session-1" });
const tools = [...getTools(fs), getShellTool(fs)];

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  system: "You are a developer working in a project directory.",
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  })),
  messages: [{ role: "user", content: "Update the pricing page to change the Pro plan from $29 to $49/month" }],
});

// Handle tool_use blocks
for (const block of response.content) {
  if (block.type === "tool_use") {
    const tool = tools.find(t => t.name === block.name)!;
    const result = await tool.execute(block.input);
    // Feed result back as tool_result...
  }
}
```

### Vercel AI SDK

```typescript
import { generateText, tool } from "ai";
import { z } from "zod";
import { Filesystem, getTools } from "s3fs-agent";

const fs = new Filesystem({ bucket: "my-bucket" });
const fsTools = getTools(fs);

const tools = Object.fromEntries(
  fsTools.map(t => [t.name, tool({
    description: t.description,
    parameters: z.object({ path: z.string() }),
    execute: async (input) => t.execute(input),
  })])
);
```

## Cloudflare R2

```typescript
const fs = new Filesystem({
  bucket: "my-r2-bucket",
  endpoint: "https://<account_id>.r2.cloudflarestorage.com",
  accessKeyId: "...",     // R2 API token
  secretAccessKey: "...",
});
```

`forcePathStyle` is set automatically when `endpoint` is provided. Works with any S3-compatible store (MinIO, Backblaze B2, DigitalOcean Spaces, etc).

## Environment Variables

Credentials resolve in order (first defined wins):

| Priority | Access Key | Secret Key | Region |
|----------|-----------|------------|--------|
| 1 | Constructor arg | Constructor arg | Constructor arg |
| 2 | `S3FS_ACCESS_KEY_ID` | `S3FS_SECRET_ACCESS_KEY` | `S3FS_REGION` |
| 3 | `AWS_ACCESS_KEY_ID` | `AWS_SECRET_ACCESS_KEY` | `AWS_REGION` |

Also: `S3FS_ENDPOINT` for custom endpoints.

## Multi-Agent Isolation

Each agent gets its own prefix — they can't see or touch each other's files:

```typescript
const agent1 = new Filesystem({ bucket: "agents", prefix: "sessions/abc123" });
const agent2 = new Filesystem({ bucket: "agents", prefix: "sessions/def456" });

// Agent 1 writes to /notes.txt → S3 key: sessions/abc123/notes.txt
// Agent 2 writes to /notes.txt → S3 key: sessions/def456/notes.txt
// They can't see each other. Path traversal (../../) is clamped at root.
```

## Optimistic Locking

For shared state between agents, the `Filesystem` class exposes ETags (the tool layer hides these from the model):

```typescript
const { content, etag } = await fs.readFile("/shared/state.json");
const updated = JSON.stringify({ ...JSON.parse(content), count: 42 });

try {
  await fs.writeFile("/shared/state.json", updated, { ifMatch: etag });
} catch (err) {
  if (err instanceof ConflictError) {
    // Another agent modified the file — re-read and retry
  }
}
```

No DynamoDB lock table. No Redis. Just S3 conditional writes.

## Security Model

- **Prefix sandboxing** — `..` traversal is clamped at root before the prefix is applied. The agent cannot escape its namespace.
- **Credential isolation** — The agent receives tool functions (closures), never the `Filesystem` instance, `S3Client`, or credentials.
- **Error sanitization** — AWS SDK errors are caught and replaced with generic messages. No bucket names, S3 keys, endpoints, or request IDs leak to the model.
- **Sentinel hiding** — `.keep` directory markers are filtered from listings and blocked from direct reads.
- **No S3 concepts in tool definitions** — Tool names, descriptions, parameter names, and return values contain zero references to S3, R2, ETags, buckets, or object storage. The model thinks it's in a sandbox.

## How It Works

- S3 keys **are** the filesystem paths. `/agents/bob/notes.txt` → S3 key `agents/bob/notes.txt`.
- Directories use `.keep` sentinel objects (same convention as AWS Console).
- No persistent state between tool calls. The S3 bucket is the only infrastructure.
- The `Filesystem` class handles path resolution, ETag normalization, error mapping.
- `getTools()` wraps it in a model-safe layer — plain strings in, plain strings out.
- `getShellTool()` adds a bash command parser on top — `ls`, `cat`, `grep`, pipes, heredocs all route through the same `Filesystem`.

## Eval Suite

The repo includes an eval framework that tests agents against a seeded project:

```bash
# Run evals against in-memory store (no infra needed)
ANTHROPIC_API_KEY=... npm run eval

# Run a single eval task
ANTHROPIC_API_KEY=... npm run eval create-component

# Run against real R2
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... npm run test:r2
```

5 eval tasks — explore project, create component, edit page, create page + update nav, multi-file refactor. All pass with Claude Sonnet.

## Tests

```bash
npm test           # 432 tests
npm run typecheck  # zero errors
npm run build      # ESM + CJS + declarations
```

## License

MIT
