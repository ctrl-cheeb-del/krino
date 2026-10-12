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

- **`head -n` and `tail -n` on big files** (1 MB and up, set with `bigFileBytes`) download only the start or end, not the whole file.
- **With a journal** (see below), writes don't wait on storage at all.

`bun run bench` runs a 250-file project against a store that adds 20 ms to every request (`JOURNAL=1 bun run bench` adds the journal):

| | v0.2.0 | write-behind | + journal |
|---|---|---|---|
| write 30 files in a loop | 1251 ms | 39 ms | 16 ms |
| `sed -i` on 20 files | 424 ms | 33 ms | 10 ms |
| `mv` a 50-file folder | 231 ms | 110 ms | 28 ms |
| `grep -rn` over 200 files | 102 ms cold, 10 ms warm | same | same |
| whole run | 2143 ms | 405 ms | 303 ms |

## Cloudflare Workers

Use the R2 binding: no API keys, no AWS SDK in your bundle (about 410 KB gzipped, needs `nodejs_compat`). `examples/cloudflare-worker` is a complete setup:

- **One Durable Object per folder.** Every agent with a token for the folder lands in the same object, so they share one set of files and see each other's changes immediately, with no conflicts, while each keeps its own `cd` and `export`.
- **A journal in the object's SQLite.** Commands return as soon as their changes are in the journal, which is durable before the response is sent. The journal is copied to R2 in the background, with an alarm retrying anything that failed. A crash loses nothing; a restarted object replays the journal.
- **Token login.** Requests need `Authorization: Bearer <token>`.

```bash
cd examples/cloudflare-worker && bun install
echo 'KRINO_SECRET=<at least 16 characters>' > .dev.vars && bun run dev
TOKEN=$(KRINO_SECRET=<same> bun token.ts acme alice)
curl -X POST localhost:8787 -H "Authorization: Bearer $TOKEN" --data-binary 'mkdir -p src && cd src'
curl -X POST localhost:8787 -H "Authorization: Bearer $TOKEN" --data-binary 'pwd'   # /workspace/src
```

Deploy with `wrangler secret put KRINO_SECRET` and `wrangler deploy`.

## Tokens and read-only access

```ts
import { createToken, authorize } from "krino";

// Opens folder "acme" only, can't write, stops working in an hour.
const token = await createToken(env.KRINO_SECRET, {
  folder: "acme",
  agent: "reviewer",
  readOnly: true,
  expiresIn: 3600,
});

const claims = await authorize(env.KRINO_SECRET, request); // null if missing, forged or expired
```

Tokens are HMAC-signed with Web Crypto, so they work in Workers, Node and Bun. A token can't be edited to open a different folder.

Read-only works without tokens too: `createBash({ ..., readOnly: true })`. Reads work normally; every write fails with `Read-only file system`.

## Several agents, one folder

Open the folder once and give each agent its own session:

```ts
const fs = await KrinoFs.open({ store, prefix: "team", writeBehind: true });
const alice = await createBash({ fs });
const bob = await createBash({ fs });
const viewer = await createBash({ fs, readOnly: true });
```

They see each other's writes immediately. Keep one process per folder (on Cloudflare, one Durable Object per folder, as the example does).

## The journal

```ts
import { journaled, r2Store } from "krino";

const store = journaled(r2Store(env.FILES), ctx.storage.sql); // any SQLite with exec(query, ...args)
await store.drain();  // copy to R2; safe to call any time, retries on failure
store.pending;        // changes not yet copied
```

Reads see journaled changes immediately. Draining runs copies, then writes, then deletes, so a moved file's source is never deleted before its copy lands. Files over 1.5 MB (Durable Object rows max out at 2 MB) and checked writes (`writeIfUnchanged`, exclusive creates) go straight to storage. Only one process should write through a journal.

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

## Agents in separate processes

If agents can't share one process, each session sees storage as it was when it opened; `shell.fs.refresh()` picks up other agents' changes. For shared state, use conditional writes:

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
- **A command's changes are saved when it ends.** If the process dies mid-command, that command's writes are lost, like an unsaved editor buffer. With a journal in a Durable Object, "saved" means in the journal, which is fast.
- **A failing `>` redirect stops the rest of the command.** just-bash doesn't catch write errors on redirects, so the session reports the error but output from earlier in the same command is lost. In practice this only affects read-only sessions and storage outages.
- **Building and running code is out of scope.** krino is storage. Tools like a WASM TypeScript checker or bundler belong in their own just-bash commands (`customCommands`), and work on top of krino unchanged.

## Tests

```bash
bun test          # 42 tests: real just-bash commands, in-memory store, journal on SQLite
bun run bench     # latency benchmark (JOURNAL=1 for the journal)
bun run typecheck
bun run build
```

## License

MIT
