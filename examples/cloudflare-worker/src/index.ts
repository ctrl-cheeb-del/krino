import { DurableObject } from "cloudflare:workers";
import { createBash, r2Store, type R2BucketLike, type Session as Shell } from "krino";

interface Env {
  FILES: R2BucketLike;
  SESSIONS: DurableObjectNamespace<Session>;
}

/**
 * One Durable Object per agent session. It keeps the file tree, read cache
 * and working directory in memory between requests, and as the only writer
 * to its folder it never needs to re-list R2. Evicted when idle; the next
 * request re-opens with a single listing.
 */
export class Session extends DurableObject<Env> {
  private shell?: Promise<Shell>;

  async exec(command: string) {
    this.shell ??= createBash({
      store: r2Store(this.env.FILES),
      prefix: `sessions/${this.ctx.id.toString()}`,
    });
    return (await this.shell).exec(command);
  }
}

// POST /<session> with a bash command as the body.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST a command", { status: 405 });
    const name = new URL(request.url).pathname.slice(1) || "default";
    const session = env.SESSIONS.get(env.SESSIONS.idFromName(name));
    return Response.json(await session.exec(await request.text()));
  },
};
