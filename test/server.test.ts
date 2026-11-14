// Tests without Docker. Stub-compiler tests always run. Tests that need the real Tectonic binary are skipped
// when it is missing: set TECTONIC_BIN and TECTONIC_TEST_CACHE (a warm Tectonic cache).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, ENV_KEYS, type AppOptions } from "../src/server.mjs";

const TECTONIC = process.env.TECTONIC_BIN ?? "";
const CACHE_SRC = process.env.TECTONIC_TEST_CACHE ?? "";
const haveTectonic = TECTONIC !== "" && CACHE_SRC !== "" && existsSync(TECTONIC) && existsSync(CACHE_SRC);
if (!haveTectonic) console.warn(`pdf-service: Tectonic tests skipped, no binary at ${TECTONIC} or no cache at ${CACHE_SRC}`);

const root = mkdtempSync(join(tmpdir(), "pdfsvc-test-"));
let readOnlyCache = "";

// Stub compiler: a Node script that obeys the first line of main.tex. It needs no PATH, so the scrubbed environment is no obstacle.
const STUB = join(root, "stub-tectonic.mjs");
writeFileSync(STUB, `#!${process.execPath}
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, arg] = readFileSync("main.tex", "utf8").split("\\n");
if (mode === "ENV") { console.error("ENV " + JSON.stringify(process.env)); process.exit(1); }
if (mode === "FAIL") { console.log("! stub error at " + new URL("..", "file://" + process.cwd() + "/").pathname + "main.tex"); process.exit(1); }
if (mode === "NOPDF") process.exit(0);
if (mode === "BG") { const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},300000)"], { stdio: "ignore" }); writeFileSync(arg, String(c.pid)); setTimeout(()=>{}, 300000); }
else {
  if (mode === "SLEEP") await new Promise((r) => setTimeout(r, Number(arg ?? 600)));
  mkdirSync("../out", { recursive: true });
  writeFileSync("../out/main.pdf", mode === "ECHO" ? readFileSync(arg) : Buffer.from("%PDF-1.5 stub"));
}
`, { mode: 0o755 });

/** True when the process exists and is not a zombie (a killed orphan can stay a zombie until init reaps it). */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

const open: { close: () => void }[] = [];
async function start(opts: AppOptions = {}) {
  const jobRoot = mkdtempSync(join(root, "jobs-"));
  const app = await createApp({ tectonicBin: STUB, cacheDir: join(root, "no-cache"), jobRoot, ...opts });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  open.push(app.server);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  type Reply = Omit<Response, "json"> & { json(): Promise<any> };
  const compile = async (body: unknown) => (await fetch(`${base}/compile`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })) as Reply;
  return { ...app, base, jobRoot, compile };
}
afterEach(() => { for (const s of open.splice(0)) s.close(); });
beforeAll(() => {
  if (!haveTectonic) return;
  // A read-only copy of the cache, as the image has it at run time.
  readOnlyCache = join(root, "cache");
  cpSync(CACHE_SRC, readOnlyCache, { recursive: true });
  const lock = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) lock(p); else chmodSync(p, 0o444); } chmodSync(d, 0o555); };
  lock(readOnlyCache);
});
afterAll(() => {
  const unlock = (d: string) => { if (!existsSync(d)) return; chmodSync(d, 0o755); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(join(d, e.name)); };
  unlock(readOnlyCache);
  rmSync(root, { recursive: true, force: true });
});

describe("pdf-service routes", () => {
  it("answers GET /health with 200", async () => {
    const a = await start();
    const r = await fetch(`${a.base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });
  it("answers 404 for an unknown path and 405 for a wrong method", async () => {
    const a = await start();
    expect((await fetch(`${a.base}/nope`)).status).toBe(404);
    expect((await fetch(`${a.base}/compile`)).status).toBe(405);
    expect((await fetch(`${a.base}/health`, { method: "POST" })).status).toBe(405);
  });
  it("returns the PDF as application/pdf and removes the job directory", async () => {
    const a = await start();
    const r = await a.compile({ main: "OK" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    expect(readdirSync(a.jobRoot)).toEqual([]);
  });
  it("rejects a body that is not JSON, not an object, or has no main", async () => {
    const a = await start();
    expect((await a.compile("{nope")).status).toBe(400);
    expect((await a.compile([])).status).toBe(400);
    expect((await a.compile({ files: {} })).status).toBe(400);
    expect((await a.compile({ main: "x", files: [] })).status).toBe(400);
    expect((await a.compile({ main: "x", files: { "a.txt": 5 } })).status).toBe(400);
    expect((await a.compile({ main: "x", files: { "a.bin": { encoding: "base64", content: "!!!" } } })).status).toBe(400);
  });
  it("passes text and base64 files to the job, including in sub-directories", async () => {
    const a = await start();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const r = await a.compile({ main: "ECHO\nsub/dir/a.bin", files: { "sub/dir/a.bin": { encoding: "base64", content: bytes.toString("base64") } } });
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
  });
});

describe("pdf-service path rejection", () => {
  const cases: [string, string][] = [
    ["parent segment", "../x.tex"],
    ["nested parent segment", "a/../../x.tex"],
    ["parent segment that normalises inside the job", "a/../b.tex"],
    ["bare parent", ".."],
    ["absolute path", "/etc/passwd"],
    ["drive letter", "C:/x.tex"],
    ["backslash", "a\\b.tex"],
    ["backslash traversal", "..\\x.tex"],
    ["NUL byte", "a\0b.tex"],
    ["reserved main.tex", "main.tex"],
    ["reserved main.tex through ./", "./main.tex"],
    ["reserved main.tex through a segment", "sub/../main.tex"],
    ["reserved main.tex in other case", "MAIN.TEX"],
    ["empty name", ""],
    ["dot", "."],
    ["trailing slash", "dir/"],
  ];
  for (const [label, name] of cases) {
    it(`rejects ${label} with 400`, async () => {
      const a = await start();
      const r = await a.compile({ main: "OK", files: { [name]: "x" } });
      expect(r.status).toBe(400);
      expect(typeof (await r.json()).error).toBe("string");
      expect(readdirSync(a.jobRoot)).toEqual([]);
    });
  }
  it("rejects two names that normalise to the same file", async () => {
    const a = await start();
    expect((await a.compile({ main: "OK", files: { "a.tex": "1", "./a.tex": "2" } })).status).toBe(400);
  });
  it("rejects a name that is both a file and a directory", async () => {
    const a = await start();
    expect((await a.compile({ main: "OK", files: { a: "1", "a/b.tex": "2" } })).status).toBe(400);
  });
  it("rejects a name from the assets directory", async () => {
    const assetsDir = join(root, "assets"); mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "mystyle.sty"), "% stub");
    writeFileSync(join(assetsDir, ".gitkeep"), "");
    const a = await start({ assetsDir });
    const r = await a.compile({ main: "OK", files: { "MyStyle.sty": "% mine" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("built-in asset");
    expect((await a.compile({ main: "OK" })).status).toBe(200);
  });
  it("does not reserve dot files in the assets directory", async () => {
    const assetsDir = join(root, "assets-dot"); mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, ".gitkeep"), "");
    const a = await start({ assetsDir });
    expect((await a.compile({ main: "OK", files: { ".gitkeep": "mine" } })).status).toBe(200);
  });
});

describe("pdf-service size limits", () => {
  it("rejects a document over 2 MB with 413", async () => {
    const a = await start();
    expect((await a.compile({ main: "x".repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await a.compile({ main: "x".repeat(2 * 1024 * 1024) })).status).toBe(200);
  });
  it("rejects a file over 5 MB with 413, text and base64", async () => {
    const a = await start();
    expect((await a.compile({ main: "OK", files: { "big.txt": "x".repeat(5 * 1024 * 1024 + 1) } })).status).toBe(413);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    expect((await a.compile({ main: "OK", files: { "big.bin": { encoding: "base64", content: big } } })).status).toBe(413);
    expect((await a.compile({ main: "OK", files: { "ok.txt": "x".repeat(5 * 1024 * 1024) } })).status).toBe(200);
  });
  it("rejects more than 50 files with 413", async () => {
    const a = await start();
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, "x"]));
    expect((await a.compile({ main: "OK", files: files(51) })).status).toBe(413);
    expect((await a.compile({ main: "OK", files: files(50) })).status).toBe(200);
  });
  it("rejects more than 20 MB in total with 413", async () => {
    const a = await start();
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, "x".repeat(4.5 * 1024 * 1024)]));
    expect((await a.compile({ main: "OK", files })).status).toBe(413);
  });
});

describe("pdf-service compiler handling (stub compiler)", () => {
  it("returns 422 with the log and strips the job directory from it", async () => {
    const a = await start();
    const r = await a.compile({ main: "FAIL\n" });
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.error).toBe("compilation failed");
    expect(j.log).toContain("stub error at <job>");
    expect(j.log).not.toContain(a.jobRoot);
    expect(readdirSync(a.jobRoot)).toEqual([]);
  });
  it("keeps only the last 8 KB of the log", async () => {
    const big = join(root, "noisy.mjs");
    writeFileSync(big, `#!${process.execPath}\nconsole.log("A".repeat(50000)); console.log("THE-END"); process.exit(1);\n`, { mode: 0o755 });
    const a = await start({ tectonicBin: big });
    const j = await (await a.compile({ main: "x" })).json();
    expect(Buffer.byteLength(j.log)).toBeLessThanOrEqual(8 * 1024);
    expect(j.log).toContain("THE-END");
  });
  it("returns 500 when the compiler writes no PDF", async () => {
    const a = await start();
    expect((await a.compile({ main: "NOPDF\n" })).status).toBe(500);
  });
  it("returns 500 when the compiler binary does not exist", async () => {
    const a = await start({ tectonicBin: join(root, "missing-binary") });
    const r = await a.compile({ main: "x" });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain(root);
  });
  it("gives the compiler only PATH, HOME, TECTONIC_CACHE_DIR and TMPDIR", async () => {
    process.env.PDF_TEST_SECRET = "s3cret-value"; process.env.PDF_TOKEN = "bearer-secret";
    try {
      const a = await start();
      const j = await (await a.compile({ main: "ENV\n" })).json();
      const env = JSON.parse(/ENV (\{.*\})/.exec(j.log)![1]);
      expect(Object.keys(env).sort()).toEqual([...ENV_KEYS].sort());
      expect(j.log).not.toContain("s3cret-value");
      expect(j.log).not.toContain("bearer-secret");
    } finally { delete process.env.PDF_TEST_SECRET; delete process.env.PDF_TOKEN; }
  });
  it("kills the whole process group on timeout and answers 422", async () => {
    const a = await start({ timeoutMs: 700 });
    const pidFile = join(root, "bg.pid");
    const t0 = Date.now();
    const r = await a.compile({ main: `BG\n${pidFile}` });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("limit");
    expect(Date.now() - t0).toBeLessThan(5000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r2) => setTimeout(r2, 200));
    expect(isAlive(pid)).toBe(false); // the background child is gone
    expect(readdirSync(a.jobRoot)).toEqual([]);
  });
  it("runs at most 2 compiles at once, queues the rest and answers 503 past 8 waiting", async () => {
    const a = await start({ concurrency: 2, maxQueue: 8 });
    const all = await Promise.all(Array.from({ length: 12 }, () => a.compile({ main: "SLEEP\n400" })));
    const statuses = all.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(10); // 2 running + 8 waiting
    expect(statuses.filter((s) => s === 503)).toHaveLength(2);
    expect(all.find((r) => r.status === 503)!.headers.get("retry-after")).toBe("5");
    expect(a.stats.maxActive).toBe(2);
    expect(a.stats.active).toBe(0);
    expect(a.stats.waiting).toBe(0);
  });
  it("does not run a queued job before a slot is free", async () => {
    const a = await start({ concurrency: 1, maxQueue: 8 });
    const t0 = Date.now();
    await Promise.all([a.compile({ main: "SLEEP\n500" }), a.compile({ main: "SLEEP\n500" })]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });
});

describe.skipIf(!haveTectonic)("pdf-service with Tectonic (needs the binary and a warm cache)", () => {
  const real = (opts: AppOptions = {}) => start({ tectonicBin: TECTONIC, cacheDir: readOnlyCache, ...opts });
  const doc = (body: string) => `\\documentclass{article}\\begin{document}${body}\\end{document}`;

  it("compiles a valid document to a PDF", async () => {
    const a = await real();
    const r = await a.compile({ main: doc("Hello \\input{part}"), files: { "part.tex": "from a file" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    const pdf = Buffer.from(await r.arrayBuffer());
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
    expect(readdirSync(a.jobRoot)).toEqual([]);
  });
  it("returns 422 with a log for a syntax error", async () => {
    const a = await real();
    const r = await a.compile({ main: doc("\\undefinedcommand") });
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.log).toContain("Undefined control sequence");
    expect(j.log).not.toContain(a.jobRoot);
  });
  it("fails, instead of downloading, when a package is not in the cache", async () => {
    const a = await real();
    const r = await a.compile({ main: `\\documentclass{article}\\usepackage{definitely-not-a-package}\\begin{document}x\\end{document}` });
    expect(r.status).toBe(422);
  });
  it("shows the compiler only the four allowed variables when the document reads /proc/self/environ", async () => {
    process.env.PDF_TEST_SECRET = "s3cret-value"; process.env.PDF_TOKEN = "bearer-secret";
    try {
      const a = await real();
      // NUL is catcode 12 so the whole environ block is read as one line and printed, then \undefined stops the run.
      const r = await a.compile({ main: doc("\\catcode0=12 \\newread\\f \\openin\\f=/proc/self/environ \\read\\f to\\x \\typeout{ENVIRON[\\meaning\\x]}\\undefinedcommand") });
      expect(r.status).toBe(422);
      const { log } = await r.json();
      expect(log).toContain("ENVIRON[macro:->PATH=");
      for (const k of ENV_KEYS) expect(log).toContain(`${k}=`);
      expect(log).not.toContain("s3cret-value");
      expect(log).not.toContain("bearer-secret");
      expect(log).not.toContain("PDF_TEST_SECRET");
      const names = [...log.matchAll(/(?:^|\0|\^\^@)([A-Z_]+)=/g)].map((m: RegExpMatchArray) => m[1]);
      for (const n of names) expect(ENV_KEYS).toContain(n);
    } finally { delete process.env.PDF_TEST_SECRET; delete process.env.PDF_TOKEN; }
  });
  it("does not run a command from \\write18", async () => {
    const marker = join(root, "write18-marker");
    const a = await real();
    const r = await a.compile({ main: doc(`\\immediate\\write18{touch ${marker}}\\immediate\\write18{/bin/sh -c "touch ${marker}"}x`) });
    expect(existsSync(marker)).toBe(false);
    expect([200, 422]).toContain(r.status);
  });
  it("kills a runaway document at the timeout", async () => {
    const a = await real({ timeoutMs: 2000 });
    const t0 = Date.now();
    const r = await a.compile({ main: "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("limit");
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(readdirSync(a.jobRoot)).toEqual([]);
  });
  it("compiles a document that loads a style file from the assets directory", async () => {
    const assetsDir = join(root, "assets-real"); mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "mystyle.sty"), "\\ProvidesPackage{mystyle}\\newcommand{\\greeting}{Hello from assets}");
    const a = await real({ assetsDir });
    const r = await a.compile({ main: "\\documentclass{article}\\usepackage{mystyle}\\begin{document}\\greeting\\end{document}" });
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
  }, 60000);
});
