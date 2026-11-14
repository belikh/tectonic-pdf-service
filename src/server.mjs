// LaTeX to PDF over HTTP. Runs Tectonic once per request in a fresh directory.
//
// AUTHENTICATION: this process reads no bearer token and holds no secret. The caller is the Worker's
// PdfCompiler Durable Object, which checks the token (examples/cloudflare-worker/container.ts) and reaches this port only
// through ctx.container.getTcpPort(8080). Do not publish the port anywhere else.
//
// ISOLATION: Tectonic runs with --untrusted (no shell escape), --only-cached (no network), an environment of
// four variables, its own process group (killed on timeout), and in a job directory that is removed afterwards.
// Tectonic does not block reads of absolute paths, so file-read isolation depends on the OS: run as an
// unprivileged user with nothing secret in the container (see the Dockerfile).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { LIMITS, MAX_BODY_BYTES, RequestError, validateRequest } from "./validate.mjs";

export const DEFAULT_BUNDLE = "https://relay.fullyjustified.net/default_bundle_v33.tar";
export const LOG_TAIL_BYTES = 8 * 1024;
export const ENV_KEYS = ["PATH", "HOME", "TECTONIC_CACHE_DIR", "TMPDIR"];

/**
 * @param {object} [options]
 * @param {string} [options.tectonicBin]    path or name of the tectonic binary (default env TECTONIC_BIN or "tectonic")
 * @param {string} [options.cacheDir]       Tectonic cache (default env TECTONIC_CACHE_DIR or /opt/tectonic-cache)
 * @param {string} [options.bundle]         pinned bundle URL (default env TECTONIC_BUNDLE or DEFAULT_BUNDLE)
 * @param {string} [options.assetsDir]      files copied flat into every job: class files, fonts, images (default env ASSETS_DIR; none when unset). Names that start with "." are skipped.
 * @param {string} [options.jobRoot]        where job directories go (default os.tmpdir())
 * @param {number} [options.timeoutMs]      compile timeout (default 60000)
 * @param {number} [options.concurrency]    simultaneous compiles (default 2)
 * @param {number} [options.maxQueue]       waiting compiles before 503 (default 8)
 */
export async function createApp(options = {}) {
  const env = process.env;
  const cfg = {
    tectonicBin: options.tectonicBin ?? env.TECTONIC_BIN ?? "tectonic",
    cacheDir: options.cacheDir ?? env.TECTONIC_CACHE_DIR ?? "/opt/tectonic-cache",
    bundle: options.bundle ?? env.TECTONIC_BUNDLE ?? DEFAULT_BUNDLE,
    assetsDir: options.assetsDir ?? env.ASSETS_DIR ?? "",
    jobRoot: options.jobRoot ?? tmpdir(),
    timeoutMs: options.timeoutMs ?? 60_000,
    concurrency: options.concurrency ?? 2,
    maxQueue: options.maxQueue ?? 8,
  };
  // Fail closed at start-up: the job root must be writable.
  await mkdir(cfg.jobRoot, { recursive: true });
  const jobRoot = await realpath(cfg.jobRoot);

  // Entries of the assets directory that go into every job. Dot files (such as .gitkeep) are placeholders.
  const assetEntries = cfg.assetsDir
    ? (await readdir(cfg.assetsDir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."))
    : [];
  // Names the caller may not send: everything in the assets directory (top level, lower case).
  const reserved = new Set(assetEntries.map((e) => e.name.toLowerCase()));

  // Counting semaphore with a bounded queue.
  const stats = { active: 0, waiting: 0, maxActive: 0, served: 0 };
  const queue = [];
  const acquire = () => new Promise((resolveSlot, reject) => {
    if (stats.active < cfg.concurrency) { stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active); resolveSlot(); return; }
    if (queue.length >= cfg.maxQueue) { reject(new RequestError(503, "compile queue is full; retry later")); return; }
    queue.push(resolveSlot); stats.waiting = queue.length;
  });
  const release = () => {
    const next = queue.shift(); stats.waiting = queue.length;
    if (next) { stats.maxActive = Math.max(stats.maxActive, stats.active); next(); } else stats.active--;
  };

  const compilerEnv = (jobDir) => ({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(jobDir, "tmp"),
    TECTONIC_CACHE_DIR: cfg.cacheDir,
    TMPDIR: join(jobDir, "tmp"),
  });

  /** Removes server paths from compiler output, keeps the last 8 KB. */
  const cleanLog = (text, jobDir) => {
    let t = text.split(join(jobDir, "src") + sep).join("").split(jobDir).join("<job>");
    t = t.split(cfg.cacheDir).join("<cache>");
    const buf = Buffer.from(t, "utf8");
    return (buf.length > LOG_TAIL_BYTES ? buf.subarray(buf.length - LOG_TAIL_BYTES) : buf).toString("utf8").replace(/^�+/, "");
  };

  async function compile(job) {
    const jobDir = await mkdtemp(join(jobRoot, "job-")); // mode 0700
    try {
      const src = join(jobDir, "src");
      await mkdir(src); await mkdir(join(jobDir, "out")); await mkdir(join(jobDir, "tmp"));
      for (const e of assetEntries) {
        if (e.isDirectory()) await cp(join(cfg.assetsDir, e.name), join(src, e.name), { recursive: true });
        else await copyFile(join(cfg.assetsDir, e.name), join(src, e.name));
      }
      for (const f of job.files) {
        const target = resolve(src, f.path);
        if (!target.startsWith(src + sep)) throw new RequestError(400, `file name escapes the job directory: ${f.path}`);
        try {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.data, { flag: "wx" });
        } catch (e) {
          if (e && (e.code === "EEXIST" || e.code === "ENOTDIR" || e.code === "EISDIR")) throw new RequestError(400, `file name conflicts with another file: ${f.path}`);
          throw e;
        }
      }
      await writeFile(join(src, "main.tex"), job.main, { flag: "w" });

      const args = ["-X", "compile", "main.tex", "--untrusted", "--only-cached", "--bundle", cfg.bundle, "--outdir", "../out"];
      let tail = "";
      const result = await new Promise((resolveRun) => {
        let timedOut = false;
        let settled = false;
        const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); resolveRun({ err, timedOut }); };
        // spawn with shell:false takes the same argument vector as execFile. It is used because execFile does not pass
        // `detached` through, and the child must lead its own process group so a timeout can kill the whole group.
        const child = spawn(cfg.tectonicBin, args, { cwd: src, env: compilerEnv(jobDir), detached: true, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const keep = (d) => { tail = (tail + d.toString("utf8")).slice(-4 * LOG_TAIL_BYTES); };
        child.stdout.on("data", keep); child.stderr.on("data", keep);
        child.on("error", (e) => done(e));
        child.on("close", (code, signal) => done(code === 0 ? null : Object.assign(new Error(`exit ${code ?? signal}`), { code: code ?? signal })));
        const timer = setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
        }, cfg.timeoutMs);
      });

      if (result.timedOut) return { status: 422, json: { error: `compilation exceeded the ${cfg.timeoutMs / 1000} s limit and was killed`, log: cleanLog(tail, jobDir) } };
      if (result.err) {
        if (result.err.code === "ENOENT") return { status: 500, json: { error: "compiler is not installed on this server" } };
        return { status: 422, json: { error: "compilation failed", log: cleanLog(tail, jobDir) } };
      }
      try {
        return { status: 200, pdf: await readFile(join(jobDir, "out", "main.pdf")) };
      } catch {
        return { status: 500, json: { error: "compiler exited without writing a PDF", log: cleanLog(tail, jobDir) } };
      }
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }

  const send = (res, status, body, type = "application/json") => {
    const data = type === "application/json" ? Buffer.from(JSON.stringify(body)) : body;
    res.writeHead(status, { "content-type": type, "content-length": data.length, "cache-control": "no-store", ...(status === 503 ? { "retry-after": "5" } : {}) });
    res.end(data);
  };

  const readBody = (req) => new Promise((resolveBody, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(new RequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)); req.pause(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/health") {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
        return send(res, 200, { status: "ok" });
      }
      if (path === "/compile") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { throw new RequestError(400, "body is not valid JSON"); }
        const job = validateRequest(body, reserved);
        await acquire();
        let out;
        try { out = await compile(job); } finally { release(); }
        stats.served++;
        if (out.pdf) return send(res, 200, out.pdf, "application/pdf");
        return send(res, out.status, out.json);
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof RequestError) {
        if (e.status === 413) res.setHeader("connection", "close");
        return send(res, e.status, { error: e.message });
      }
      console.error("unhandled error", e?.message ?? e);
      return send(res, 500, { error: "internal error" });
    }
  });

  return { server, stats, config: { ...cfg, limits: LIMITS } };
}
