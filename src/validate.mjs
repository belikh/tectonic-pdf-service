// Request validation for POST /compile. Every rejection is an Error with a `status` (400 or 413).
import { posix } from "node:path";

export const LIMITS = Object.freeze({
  mainBytes: 2 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  fileCount: 50,
  totalBytes: 20 * 1024 * 1024,
});

/** Largest request body the server reads: the total limit as base64 (4/3) plus JSON overhead. */
export const MAX_BODY_BYTES = Math.ceil((LIMITS.totalBytes * 4) / 3) + 1024 * 1024;

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new RequestError(400, m);
const tooBig = (m) => new RequestError(413, m);

/**
 * Turns a file name from the request into a normalised relative POSIX path.
 * Rejects (does not repair) absolute paths, backslashes, NUL, drive letters, `..` segments,
 * the reserved name main.tex and any name in `reserved` (compared in lower case).
 */
export function cleanPath(name, reserved = new Set()) {
  if (typeof name !== "string" || name === "") throw bad("file name must be a non-empty string");
  if (name.includes("\0")) throw bad(`file name contains NUL: ${JSON.stringify(name)}`);
  if (name.includes("\\")) throw bad(`file name contains a backslash: ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw bad(`file name is absolute: ${JSON.stringify(name)}`);
  if (name.split("/").includes("..")) throw bad(`file name contains a '..' segment: ${JSON.stringify(name)}`);
  const norm = posix.normalize(name);
  if (norm === "." || norm === ".." || norm.startsWith("../") || norm.startsWith("/") || norm.endsWith("/") || norm.split("/").includes("..")) {
    throw bad(`file name does not name a file inside the job: ${JSON.stringify(name)}`);
  }
  if (norm.length > 200) throw bad("file name is longer than 200 characters");
  const lower = norm.toLowerCase();
  if (lower === "main.tex") throw bad("main.tex is reserved: send the document as `main`");
  if (reserved.has(lower)) throw bad(`${norm} is part of the built-in Jupiter style and cannot be replaced`);
  return norm;
}

function decodedBase64Length(s) {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * Validates the parsed JSON body. Returns { main: Buffer, files: [{ path, data: Buffer }] }.
 * 413 for a size limit, 400 for anything else wrong with the request.
 */
export function validateRequest(body, reserved = new Set()) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("body must be a JSON object");
  const { main, files } = body;
  if (typeof main !== "string" || main === "") throw bad("`main` must be a non-empty string");
  const mainBytes = Buffer.byteLength(main, "utf8");
  if (mainBytes > LIMITS.mainBytes) throw tooBig(`main is ${mainBytes} bytes; the limit is ${LIMITS.mainBytes}`);
  if (main.includes("\0")) throw bad("main contains NUL");
  if (files !== undefined && (files === null || typeof files !== "object" || Array.isArray(files))) throw bad("`files` must be an object of name to content");
  const entries = Object.entries(files ?? {});
  if (entries.length > LIMITS.fileCount) throw tooBig(`${entries.length} files; the limit is ${LIMITS.fileCount}`);

  const out = [];
  const seen = new Set();
  let total = mainBytes;
  for (const [name, value] of entries) {
    const path = cleanPath(name, reserved);
    if (seen.has(path.toLowerCase())) throw bad(`duplicate file name after normalisation: ${path}`);
    seen.add(path.toLowerCase());
    let size;
    let data;
    if (typeof value === "string") {
      size = Buffer.byteLength(value, "utf8");
      if (size > LIMITS.fileBytes) throw tooBig(`${path} is ${size} bytes; the limit is ${LIMITS.fileBytes}`);
      data = () => Buffer.from(value, "utf8");
    } else if (value && typeof value === "object" && !Array.isArray(value) && value.encoding === "base64" && typeof value.content === "string") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.content) || value.content.length % 4 !== 0) throw bad(`${path} is not valid base64`);
      size = decodedBase64Length(value.content);
      if (size > LIMITS.fileBytes) throw tooBig(`${path} is ${size} bytes; the limit is ${LIMITS.fileBytes}`);
      data = () => Buffer.from(value.content, "base64");
    } else {
      throw bad(`${path} must be a string or {"encoding":"base64","content":"..."}`);
    }
    total += size;
    if (total > LIMITS.totalBytes) throw tooBig(`request content exceeds ${LIMITS.totalBytes} bytes in total`);
    out.push({ path, data });
  }
  // Parents of a file may not be files themselves ("a" and "a/b"): that would fail at write time.
  for (const p of seen) {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
      if (seen.has(p.slice(0, i))) throw bad(`${p.slice(0, i)} is both a file and a directory`);
    }
  }
  return { main: Buffer.from(main, "utf8"), files: out.map((f) => ({ path: f.path, data: f.data() })) };
}
