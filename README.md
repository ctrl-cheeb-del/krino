# krino

*κρίνω (Greek): to judge, to distinguish, to discern*

Persistent files for [just-bash](https://github.com/vercel-labs/just-bash), stored in Cloudflare R2 or any S3-compatible bucket.

just-bash gives an AI agent a convincing bash shell written in TypeScript. krino gives that shell a disk that survives. The agent runs `ls`, `grep -r`, `sed -i` and heredocs as usual; the files land in your bucket. There is no VM, no container, and nothing running between commands, so an idle agent costs nothing.

```ts
import { createBash, r2Store } from "krino";

const shell = await createBash({
  store: r2Store(env.FILES),        // Workers R2 binding
  prefix: `sessions/${sessionId}`,  // one folder per agent
});

await shell.exec("mkdir -p src && cd src && echo 'export const x = 1' > a.ts");
await shell.exec("pwd && sed -i 's/1/2/' *.ts");   // still in /workspace/src

const tool = shell.tool(); // { name: "bash", description, inputSchema, execute }
```

## It behaves like a terminal

- **`cd` and `export` carry over** between `exec` calls (plain just-bash resets them on every call). If the current folder is deleted, the shell falls back to `/workspace`.
- **Stored files are at `/workspace`**, the starting directory. `/tmp`, `/dev` and `/proc` are in memory and last as long as the session.
- **Every `exec` saves its changes before returning.** If saving fails, the command gets a normal shell error (`write error: Input/output error`) and exit code 1, and the changes are retried on the next command. No bucket names, keys or SDK messages ever reach the agent.
- **Overlapping `exec` calls run one at a time**, in order.
- **The tool's output keeps its start and its end** when it's too long, since errors are usually at the bottom.

## Why it's fast

Object storage is slow per request (tens of milliseconds) but cheap and parallel. krino is designed around that:

- **The folder tree is listed once** when the session opens and kept in memory. `ls`, `find`, `stat`, `cd` and `test -d` cost no requests.
- **Writes are held until the command finishes**, then sent in parallel. A file written several times in one command (`>`, then `>>`) costs one request.
- **Reads are cached** (32 MB by default) until the file changes. Empty files cost nothing. `shell.fs.warm()` prefetches a folder in parallel.
- **Copies and moves use server-side copy** when the store supports it. Saves run copies first, then writes, then deletes, so a move never deletes its source before the copy has landed. A failed copy leaves the source in place.

`bun run bench` runs a 250-file project against a store that adds 20 ms to every request:

| | v0.2.0 | now |
|---|---|---|
| write 30 files in a loop | 1251 ms | 37 ms |
| `sed -i` on 20 files | 424 ms | 33 ms |
| `mv` a 50-file folder | 231 ms | 109 ms |
| `grep -rn` over 200 files | 102 ms cold, 10 ms warm | same |
| whole run | 2143 ms | 416 ms |

## Cloudflare Workers

Use the R2 binding: no API keys, no AWS SDK in your bundle (about 410 KB gzipped, needs `nodejs_compat`).

For agents, put each session in a **Durable Object**. It keeps the tree, cache and working directory in memory between requests, and as the only writer to its folder it never needs to re-list. `examples/cloudflare-worker` does exactly this:

```bash
cd examples/cloudflare-worker && bun install && bun run dev
curl -X POST localhost:8787/demo --data-binary 'mkdir -p src && cd src'
curl -X POST localhost:8787/demo --data-binary 'pwd'   # /workspace/src
```

## S3, R2 over HTTP, MinIO, B2

```ts
import { createBash } from "krino";
import { s3Store } from "krino/s3"; // separate entry so Workers never load the SDK

const shell = await createBash({
  store: s3Store({
    bucket: "agents",
    config: { endpoint: "https://<account>.r2.cloudflarestorage.com", region: "auto" },
  }),
  prefix: "sessions/abc",
});
```

Requires `@aws-sdk/client-s3`. Any other backend works too: implement the `ObjectStore` interface (`list`, `get`, `put`, `delete`, and optionally `copy`).

## Several agents, one folder

A session sees storage as it was when it opened; `shell.fs.refresh()` picks up other agents' changes. For shared state, use conditional writes:

```ts
const { content, version } = await shell.fs.readWithVersion("/state.json");
try {
  await shell.fs.writeIfUnchanged("/state.json", next(content), version);
} catch (err) {
  if (err instanceof ConflictError) { /* someone else wrote first: re-read and retry */ }
}
```

## Using `KrinoFs` directly

`KrinoFs.open({ store, prefix })` is a plain just-bash `IFileSystem` you can mount anywhere, for example inside your own `MountableFs`. It saves every change immediately unless you pass `writeBehind: true`, in which case call `fs.flush()` yourself. `shell.bash.exec()` skips the session's saving and state handling; use `shell.exec()`.

## Limits

- **No running programs.** `node`, `npm` and `tsc` aren't available, same as plain just-bash. just-bash's optional Python and SQLite commands still work.
- **Object storage has no symlinks, hard links or file modes.** `ln` fails with `EPERM`, and `chmod` or `touch -d` last only for the session.
- **A command's changes are saved when it ends.** If the process dies mid-command, that command's writes are lost, like an unsaved editor buffer.

## Tests

```bash
bun test          # 27 tests: real just-bash commands against an in-memory store
bun run bench     # latency benchmark
bun run typecheck
bun run build
```

## License

MIT
