// Worker-side client for the compile service.
// It is switched off unless the Worker has PDF_ENABLED = "on" and a PDF_COMPILER binding, and then makes one call without a retry.
// Caching a result is the caller's concern; the key belongs to whoever knows what the document depends on.

/** A Durable Object stub or any object with fetch(). The tests pass a plain stub. */
export type PdfFetcher = { fetch(input: string | Request, init?: RequestInit): Promise<Response> };

/** The bindings this client reads. Merge these into your own Env type. */
export type PdfEnv = {
  PDF_ENABLED?: string;
  /** Durable Object namespace of the PdfCompiler class (container.ts). */
  PDF_COMPILER?: { getByName(name: string): PdfFetcher };
  /** Worker secret. The PdfCompiler Durable Object compares it with the Authorization header. */
  PDF_TOKEN?: string;
};

export type PdfFile = string | { encoding: "base64"; content: string };
export type PdfInput = { main: string; files?: Record<string, PdfFile> };
export type PdfResult = { ok: true; pdf: ArrayBuffer } | { ok: false; status: number; log: string };

/** Compile timeout: the container kills a compile at 60 s, so 70 s leaves room for a cold start check and the transfer. */
export const PDF_TIMEOUT_MS = 70_000;
/** Instances of the fixed pool. Keep equal to max_instances in wrangler.jsonc. */
export const PDF_POOL_SIZE = 3;
export const PDF_DISABLED_MESSAGE = "PDF generation is not enabled on this deployment";

export const bearerHeader = (token: string) => `Bearer ${token}`;

/** Constant-time check of an Authorization header against the expected token. Compares SHA-256 digests so the lengths always match. */
export async function bearerMatches(header: string | null, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(header ?? "")), crypto.subtle.digest("SHA-256", enc.encode(bearerHeader(token)))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function compilePdf(env: PdfEnv, input: PdfInput): Promise<PdfResult> {
  if (env.PDF_ENABLED !== "on" || env.PDF_COMPILER === undefined) return { ok: false, status: 501, log: PDF_DISABLED_MESSAGE };
  if (!env.PDF_TOKEN) return { ok: false, status: 500, log: "PDF_TOKEN is not set" };
  const stub = env.PDF_COMPILER.getByName(`instance-${Math.floor(Math.random() * PDF_POOL_SIZE)}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PDF_TIMEOUT_MS);
  try {
    const res = await stub.fetch("http://pdf/compile", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearerHeader(env.PDF_TOKEN) },
      body: JSON.stringify({ main: input.main, files: input.files ?? {} }),
      signal: ctl.signal,
    });
    if (res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("application/pdf")) return { ok: true, pdf: await res.arrayBuffer() };
    const text = await res.text();
    let log = text;
    try {
      const j = JSON.parse(text) as { error?: string; log?: string };
      log = [j.error, j.log].filter(Boolean).join("\n") || text;
    } catch { /* not JSON: keep the text */ }
    return { ok: false, status: res.status === 200 ? 502 : res.status, log };
  } catch (e) {
    if (ctl.signal.aborted) return { ok: false, status: 504, log: `PDF compile did not answer within ${PDF_TIMEOUT_MS / 1000} s` };
    return { ok: false, status: 502, log: `PDF service unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
