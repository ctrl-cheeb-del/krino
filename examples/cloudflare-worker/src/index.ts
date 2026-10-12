import { DurableObject } from "cloudflare:workers";
import {
  authorize,
  createBash,
  journaled,
  KrinoFs,
  r2Store,
  type JournaledStore,
  type R2BucketLike,
  type Session,
} from "krino";

interface Env {
  FILES: R2BucketLike;
  FOLDERS: DurableObjectNamespace<Folder>;
  /** Signs tokens. Set with `wrangler secret put KRINO_SECRET`. */
  KRINO_SECRET: string;
}

const RETRY_MS = 10_000;

/**
 * One Durable Object per folder. Every agent with a token for the folder
 * lands here, so they share one set of files and see each other's changes
 * at once, while each keeps its own `cd` and `export`. Writes go to the
 * object's SQLite journal (durable before the response is sent) and are
 * copied to R2 in the background.
 */
export class Folder extends DurableObject<Env> {
  private store: JournaledStore;
  private fs?: Promise<KrinoFs>;
  private sessions = new Map<string, Promise<Session>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = journaled(r2Store(env.FILES), ctx.storage.sql);
  }

  async exec(folder: string, agent: string, readOnly: boolean, command: string) {
    this.fs ??= KrinoFs.open({ store: this.store, prefix: `folders/${folder}`, writeBehind: true });
    const id = `${agent}:${readOnly ? "ro" : "rw"}`;
    let session = this.sessions.get(id);
    if (!session) {
      session = this.fs.then((fs) => createBash({ fs, readOnly }));
      this.sessions.set(id, session);
    }
    const result = await (await session).exec(command);
    if (this.store.pending) {
      this.ctx.waitUntil(this.store.drain().catch(() => {}));
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    }
    return result;
  }

  /** Retries anything a background drain didn't finish. */
  async alarm() {
    await this.store.drain().catch(() => {});
    if (this.store.pending) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
  }
}

// POST / with `Authorization: Bearer <token>` and a bash command as the body.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST a command", { status: 405 });
    const claims = await authorize(env.KRINO_SECRET, request);
    if (!claims) return new Response("Unauthorized", { status: 401 });
    const folder = env.FOLDERS.get(env.FOLDERS.idFromName(claims.folder));
    return Response.json(await folder.exec(claims.folder, claims.agent, claims.readOnly, await request.text()));
  },
};
