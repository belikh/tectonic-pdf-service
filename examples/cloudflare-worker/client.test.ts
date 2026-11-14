import { describe, expect, it } from "vitest";
import { bearerMatches, compilePdf, PDF_DISABLED_MESSAGE, type PdfEnv, type PdfFetcher } from "./client.ts";

/** A stub PDF_COMPILER namespace that records every call to fetch(). */
function stub(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { name: string; url: string; init: RequestInit }[] = [];
  const names: string[] = [];
  const ns = {
    getByName(name: string): PdfFetcher {
      names.push(name);
      return { fetch: async (input, init = {}) => { const url = typeof input === "string" ? input : input.url; calls.push({ name, url, init }); return respond(url, init); } };
    },
  };
  return { ns, calls, names };
}
const on = (ns: PdfEnv["PDF_COMPILER"], extra: Partial<PdfEnv> = {}): PdfEnv => ({ PDF_ENABLED: "on", PDF_COMPILER: ns, PDF_TOKEN: "tok", ...extra });

describe("compilePdf flag", () => {
  it("returns 501 and makes no call when PDF_ENABLED is unset", async () => {
    const s = stub(() => new Response("never"));
    const r = await compilePdf({ PDF_COMPILER: s.ns, PDF_TOKEN: "tok" }, { main: "x" });
    expect(r).toEqual({ ok: false, status: 501, log: PDF_DISABLED_MESSAGE });
    expect(s.calls).toHaveLength(0);
    expect(s.names).toHaveLength(0);
  });
  it("returns 501 and makes no call when PDF_ENABLED is not exactly on", async () => {
    const s = stub(() => new Response("never"));
    for (const v of ["off", "ON", "true", ""]) expect((await compilePdf(on(s.ns, { PDF_ENABLED: v }), { main: "x" }))).toMatchObject({ ok: false, status: 501 });
    expect(s.calls).toHaveLength(0);
  });
  it("returns 501 when the PDF_COMPILER binding is missing", async () => {
    expect(await compilePdf({ PDF_ENABLED: "on" }, { main: "x" })).toEqual({ ok: false, status: 501, log: PDF_DISABLED_MESSAGE });
  });
  it("does not call the service when PDF_TOKEN is missing", async () => {
    const s = stub(() => new Response("never"));
    const r = await compilePdf(on(s.ns, { PDF_TOKEN: undefined }), { main: "x" });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(s.calls).toHaveLength(0);
  });
});

describe("compilePdf call", () => {
  it("posts the document once with the bearer token and returns the PDF bytes", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.5 test");
    const s = stub(() => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }));
    const r = await compilePdf(on(s.ns), { main: "\\documentclass{article}", files: { "a.tex": "x", "b.bin": { encoding: "base64", content: "AAEC" } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Uint8Array(r.pdf)).toEqual(bytes);
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0];
    expect(c.url).toBe("http://pdf/compile");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(c.init.body as string)).toEqual({ main: "\\documentclass{article}", files: { "a.tex": "x", "b.bin": { encoding: "base64", content: "AAEC" } } });
    expect(c.name).toMatch(/^instance-[0-2]$/);
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("returns status 422 and the log for a compile failure", async () => {
    const s = stub(() => Response.json({ error: "compilation failed", log: "! Undefined control sequence." }, { status: 422 }));
    const r = await compilePdf(on(s.ns), { main: "x" });
    expect(r).toEqual({ ok: false, status: 422, log: "compilation failed\n! Undefined control sequence." });
    expect(s.calls).toHaveLength(1); // no retry
  });
  it("passes 503 through and does not retry", async () => {
    const s = stub(() => Response.json({ error: "compile queue is full; retry later" }, { status: 503 }));
    const r = await compilePdf(on(s.ns), { main: "x" });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(s.calls).toHaveLength(1);
  });
  it("returns 502 when the stub throws", async () => {
    const s = stub(() => { throw new Error("boom"); });
    const r = await compilePdf(on(s.ns), { main: "x" });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { log: string }).log).toContain("boom");
  });
  it("returns 504 when the call is aborted at the timeout", async () => {
    const s = stub((_u, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
    const realSetTimeout = globalThis.setTimeout;
    // Run the 70 s timer immediately.
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      expect(await compilePdf(on(s.ns), { main: "x" })).toMatchObject({ ok: false, status: 504 });
    } finally { globalThis.setTimeout = realSetTimeout; }
  });
});

describe("bearerMatches", () => {
  it("accepts the exact token and rejects anything else", async () => {
    expect(await bearerMatches("Bearer tok", "tok")).toBe(true);
    expect(await bearerMatches("Bearer tok2", "tok")).toBe(false);
    expect(await bearerMatches("tok", "tok")).toBe(false);
    expect(await bearerMatches(null, "tok")).toBe(false);
    expect(await bearerMatches("Bearer ", "")).toBe(false);
    expect(await bearerMatches("Bearer undefined", undefined)).toBe(false);
  });
});
