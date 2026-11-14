// Durable Object that owns one container running this repository's image and forwards compile requests to it.
// Export it from your Worker entry point and add it to wrangler.jsonc: see "Run it on Cloudflare Containers" in the README.
//
// Built on the Durable Object Container API (this.ctx.container). The older `Container` class of @cloudflare/containers is
// deprecated, so it is not used. Names below follow https://developers.cloudflare.com/containers/api/durable-object-container/
// and the types in @cloudflare/workers-types: start(), running, getTcpPort(), setInactivityTimeout().
//
// Unverified (no Cloudflare deploy or Docker here):
//  - whether the legacy `migrations` array with new_sqlite_classes links the class to a `containers` entry without `exports`;
//  - the request and response size limit between this object and the container (the docs give none);
//  - how long a cold start takes (the FAQ says 1 to 3 s as a typical range).
import { DurableObject } from "cloudflare:workers";
import { bearerMatches } from "./client.ts";

export type PdfContainerEnv = { PDF_TOKEN?: string };

const PORT = 8080;
/** Keep the container up this long after the last request. Cost grows with it: see docs-src/developer/pdf-service.md. */
const IDLE_MS = 30_000;
const READY_DEADLINE_MS = 60_000;
const POLL_EVERY_MS = 200;
const POLL_TIMEOUT_MS = 1_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PdfCompiler extends DurableObject<PdfContainerEnv> {
  private starting: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: PdfContainerEnv) {
    super(ctx, env);
    // The inactivity timeout belongs to the running instance and is lost on restart, so set it again here when the container is already up.
    if (ctx.container?.running) void ctx.container.setInactivityTimeout(IDLE_MS);
  }

  async fetch(req: Request): Promise<Response> {
    // The Worker sends the token; the container never sees it. Fail closed when the secret is missing.
    if (!this.env.PDF_TOKEN) return json(503, { error: "PDF_TOKEN is not configured" });
    if (!(await bearerMatches(req.headers.get("authorization"), this.env.PDF_TOKEN))) return json(401, { error: "unauthorized" });

    const path = new URL(req.url).pathname;
    const allowed = (path === "/compile" && req.method === "POST") || (path === "/health" && req.method === "GET");
    if (!allowed) return json(404, { error: "not found" });

    try {
      await this.ensureStarted();
    } catch (e) {
      return json(503, { error: `PDF container did not become ready: ${e instanceof Error ? e.message : String(e)}` });
    }
    // Forward only what the container needs. The Authorization header stays here.
    const headers = new Headers();
    const type = req.headers.get("content-type");
    if (type) headers.set("content-type", type);
    const res = await this.ctx.container!.getTcpPort(PORT).fetch(`http://container${path}`, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined });
    // A request just ran, so push the idle timer out again.
    void this.ctx.container!.setInactivityTimeout(IDLE_MS);
    return res;
  }

  /** Starts the container once, shared by concurrent requests, and waits for /health. */
  private ensureStarted(): Promise<void> {
    this.starting ??= this.start().catch((e) => { this.starting = null; throw e; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container is attached to this Durable Object (check the containers entry in wrangler.jsonc)");
    if (!c.running) {
      // enableInternet is required whenever an options object is passed. No env: the container holds no secret.
      c.start({ enableInternet: false, env: {} });
    }
    await c.setInactivityTimeout(IDLE_MS);
    const deadline = Date.now() + READY_DEADLINE_MS;
    let last = "no answer";
    while (Date.now() < deadline) {
      try {
        const r = await c.getTcpPort(PORT).fetch("http://container/health", { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        if (r.ok) return;
        last = `health returned ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e); // "Container is not listening to port" until the server binds
      }
      await wait(POLL_EVERY_MS);
    }
    throw new Error(`no healthy answer from port ${PORT} within ${READY_DEADLINE_MS / 1000} s (${last})`);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
