import { createBash, r2Store, type R2BucketLike } from "krino";

interface Env {
  FILES: R2BucketLike;
}

// POST /<session> with a bash command as the body; files persist per session in R2.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST a command", { status: 405 });
    const session = new URL(request.url).pathname.slice(1) || "default";
    const { bash } = await createBash({ store: r2Store(env.FILES), prefix: `sessions/${session}` });
    const { stdout, stderr, exitCode } = await bash.exec(await request.text());
    return Response.json({ stdout, stderr, exitCode });
  },
};
