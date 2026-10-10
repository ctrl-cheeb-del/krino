# krino

*κρίνω (Greek): to judge, to distinguish, to discern*

Persistent files for [just-bash](https://github.com/vercel-labs/just-bash), stored in Cloudflare R2 or any S3-compatible bucket.

just-bash gives an AI agent a convincing bash shell written in TypeScript. krino gives that shell a disk that survives. The agent runs `ls`, `grep -r`, `sed -i` and heredocs as usual; the files land in your bucket. There is no VM, no container, and nothing running between commands, so an idle agent costs nothing.

```ts
import { createBash, bashTool, r2Store } from "krino";

const { bash } = await createBash({
  store: r2Store(env.FILES),        // Workers R2 binding
  prefix: `sessions/${sessionId}`,  // one folder per agent
});

await bash.exec("mkdir -p src && echo 'export const x = 1' > src/a.ts");
await bash.exec("grep -rn export . && sed -i 's/1/2/' src/a.ts");

const tool = bashTool(bash); // { name, description, inputSchema, execute }
```

## How it works

- **The tree lives in memory, file contents live in storage.** `createBash` lists the session's prefix once. After that, `ls`, `stat`, `find`, `cd` and `test -d` never touch the network; only reading and writing file contents do.
- **Recent reads are cached** (32 MB by default, configurable with `cacheBytes`) and stay valid until the file changes. `fs.warm()` fetches a whole folder in parallel before a `grep -r`.
- **Stored files appear at `/workspace`**, the shell's starting directory. `/tmp`, `/dev` and `/proc` are in memory and go away with the instance.
- **Empty folders persist** through a hidden `.krino-dir` marker the agent never sees.

## Cloudflare Workers

Use the R2 binding directly: no API keys, no AWS SDK in your bundle. `examples/cloudflare-worker` is a Worker that runs a POSTed command against a per-session folder:

```bash
cd examples/cloudflare-worker && bun install && bun run dev
curl -X POST localhost:8787/demo --data-binary 'echo hi > a.txt && ls -la'
```

The bundle is about 410 KB gzipped and needs the `nodejs_compat` flag.

## S3, R2 over HTTP, MinIO, B2

```ts
import { createBash } from "krino";
import { s3Store } from "krino/s3"; // separate entry so Workers never load the SDK

const { bash } = await createBash({
  store: s3Store({
    bucket: "agents",
    config: { endpoint: "https://<account>.r2.cloudflarestorage.com", region: "auto" },
  }),
  prefix: "sessions/abc",
});
```

Requires `@aws-sdk/client-s3`. Any other backend works too: implement the five-method `ObjectStore` interface.

## Several agents, one folder

Each `createBash` sees storage as it was when it opened. Call `fs.refresh()` to pick up other agents' changes. For shared state, use conditional writes:

```ts
const { fs } = await createBash({ store, prefix: "shared" });
const { content, version } = await fs.readWithVersion("/state.json");
try {
  await fs.writeIfUnchanged("/state.json", next(content), version);
} catch (err) {
  if (err instanceof ConflictError) { /* someone else wrote first: re-read and retry */ }
}
```

## What the agent never sees

- **Other sessions.** Paths are clamped at the mount, so `../../other-session` doesn't escape the prefix.
- **Storage details.** Storage failures surface as ordinary shell errors (`EIO`) with no bucket names, keys, endpoints or SDK messages.
- **Credentials.** The agent only gets the shell.

## Limits

- **No running programs.** `node`, `npm` and `tsc` aren't available, same as plain just-bash. just-bash's optional Python and SQLite commands still work.
- **Object storage has no symlinks, hard links or file modes.** `ln` fails with `EPERM`, and `chmod`/`touch -d` last only for the session.
- **`mv` is copy-then-delete,** run in parallel, so renaming a large folder costs one request per file.

## Tests

```bash
bun test        # 17 tests, real just-bash commands against an in-memory store
bun run typecheck
bun run build
```

## License

MIT
