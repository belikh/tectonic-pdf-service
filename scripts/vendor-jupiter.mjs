// Copies the Jupiter LaTeX style, fonts and graphics into ./jupiter/ so the Docker build context holds them.
// Sources (override with the environment variables):
//   JUPITER_DESIGN_DIR  default ~/projects/design      packages/latex/{src,fonts,graphics}, packages/tokens/dist/jupiter-tokens.sty
//   JUPITER_DOCS_DIR    default ~/projects/docs        latex/jupiter-docs.cls
// Usage: node scripts/vendor-jupiter.mjs [target-dir]
import { cp, mkdir, rm, readdir, copyFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const design = process.env.JUPITER_DESIGN_DIR ?? join(homedir(), "projects", "design");
const docs = process.env.JUPITER_DOCS_DIR ?? join(homedir(), "projects", "docs");
const target = resolve(process.argv[2] ?? join(here, "..", "jupiter"));
const latex = join(design, "packages", "latex");

const need = [join(latex, "src", "jupiter.sty"), join(latex, "fonts", "sgi-text-400.otf"), join(design, "packages", "tokens", "dist", "jupiter-tokens.sty"), join(docs, "latex", "jupiter-docs.cls")];
for (const f of need) await stat(f).catch(() => { throw new Error(`missing ${f}`); });

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// Everything lands flat: the documents find fonts and graphics in their own directory (\jpfontdir stays empty).
for (const dir of ["src", "fonts", "graphics"]) {
  for (const e of await readdir(join(latex, dir), { withFileTypes: true })) {
    if (e.name === "manifest.json" || e.name === "sources.lock") continue;
    const from = join(latex, dir, e.name);
    if (e.isDirectory()) await cp(from, join(target, e.name), { recursive: true });
    else await copyFile(from, join(target, e.name));
  }
}
await copyFile(join(design, "packages", "tokens", "dist", "jupiter-tokens.sty"), join(target, "jupiter-tokens.sty"));
await copyFile(join(docs, "latex", "jupiter-docs.cls"), join(target, "jupiter-docs.cls"));
console.log(`vendored the Jupiter LaTeX files into ${target}`);
