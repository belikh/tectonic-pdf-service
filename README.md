# tectonic-pdf-service

An HTTP service that compiles LaTeX to PDF with [Tectonic](https://tectonic-typesetting.github.io/) 0.17.0 inside a container. It is built for Cloudflare Containers, called from a Worker through a Durable Object. The same image runs under any container host.

The design follows the security notes in [How I Built a Secure LaTeX-to-PDF Service for Cloudflare Workers](https://hackernoon.com/how-i-built-a-secure-latex-to-pdf-service-for-cloudflare-workers) (a Cloud Run service): shell escape off, a scrubbed environment, a temporary directory per job, rejected path escapes and a cap on concurrent compiles. This repository adds an offline package cache baked into the image and the Cloudflare Worker and Durable Object code.

Status: the server and the tests were developed and run locally against a real Tectonic binary. The Docker image, the Cloudflare deployment and the image workflow have not been built or run. See "Not tested".

## Layout

| Path | Contents |
| --- | --- |
| `src/` | The HTTP server (`server.mjs`), request validation (`validate.mjs`) and the entry point (`index.mjs`). Node built-ins only. |
| `Dockerfile`, `warmup/` | Image build with a pinned Tectonic download, a package cache warmed at build time and a size check. |
| `scripts/vendor-jupiter.mjs` | Copies the Jupiter LaTeX style, fonts and graphics into `./jupiter` for the image. |
| `examples/cloudflare-worker/` | `client.ts` (Worker client with a feature flag), `container.ts` (Durable Object that starts the container) and a test for the client. |
| `test/` | Server tests. |
| `.github/workflows/image.yml` | Manual workflow that builds the image and pushes it to the Cloudflare registry. |

## API

The server listens on port 8080 (`PORT`). It reads no bearer token. Put authentication in front of it: in the Cloudflare example, a Durable Object checks a bearer token and is the only route into the container port.

| Request | Answer |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `POST /compile` | `200 application/pdf` |
| `POST /compile`, compile failed or timed out | `422 {"error": string, "log": string}`; `log` is the last 8 KB of the compiler output |
| `POST /compile`, bad request | `400 {"error": string}` |
| `POST /compile`, over a size limit | `413 {"error": string}` |
| `POST /compile`, more than 8 waiting | `503 {"error": string}` with `Retry-After: 5` |
| anything else | `404`, or `405` for a wrong method |

Request body for `POST /compile`:

```json
{
  "main": "\\documentclass{jupiter-report} ...",
  "files": {
    "chapters/one.tex": "text content",
    "logo.png": { "encoding": "base64", "content": "iVBORw0KGgo..." }
  }
}
```

`main` is written as `main.tex`. `files` is optional; each value is a UTF-8 string or a base64 object. There are no engine options.

### File names

The server rejects with 400 a name that is empty, absolute, starts with a drive letter, contains a backslash or NUL, has a `..` segment, ends in `/`, or equals `main.tex` (any case). It also rejects a name that duplicates another after normalisation, a name that is both a file and a directory, and a name that matches a file of the built-in Jupiter style (for example `jupiter.sty`). It rejects; it does not repair.

### Limits

| Limit | Value | Answer |
| --- | --- | --- |
| `main` | 2 MB | 413 |
| One file (decoded) | 5 MB | 413 |
| Number of files | 50 | 413 |
| Content in total, `main` included | 20 MB | 413 |
| Request body | 28 MB of JSON | 413 |
| Compile time | 60 s, then the process group is killed | 422 |
| Compiles at once | 2 | queued |
| Compiles waiting | 8 | the 9th waiting request gets 503 |

The limits are in `src/validate.mjs` (sizes) and `src/server.mjs` (time and queue). The tests set shorter times through `createApp` options.

## Built-in Jupiter style

The image holds the Jupiter LaTeX classes (`jupiter-report.cls` and the others), `jupiter.sty`, `jupiter-tokens.sty`, `jupiter-docs.cls`, the SGI and JetBrains Mono fonts and the line graphics in `/opt/jupiter`. The server copies them flat into every job directory before the request files, so `\documentclass{jupiter-report}` works and the fonts load from the working directory. A request cannot replace them. `npm run vendor` copies them from checkouts of [belikh/design](https://github.com/belikh/design) and [belikh/docs](https://github.com/belikh/docs) (`JUPITER_DESIGN_DIR`, `JUPITER_DOCS_DIR`) into `./jupiter`, which is git-ignored. The Dockerfile requires that directory. To build an image without the Jupiter style, remove the `jupiter` copy steps and the `jupiter.sty` checks from the Dockerfile and `warmup/warm.sh`, and leave `JUPITER_DIR` unset.

## How it is isolated

| Measure | Where |
| --- | --- |
| Each job runs in a new `mkdtemp` directory (mode 0700) that is removed in `finally` | `src/server.mjs` |
| `--untrusted` turns shell escape off. `\write18` prints "disabled" and runs nothing | tested |
| `--only-cached` plus `enableInternet: false`: a package missing from the cache is an error and there is no network path | `src/server.mjs`, `examples/cloudflare-worker/container.ts` |
| The compiler environment holds PATH, HOME, TECTONIC_CACHE_DIR and TMPDIR only | tested with a document that reads `/proc/self/environ` |
| The compiler starts in its own process group; a timeout sends SIGKILL to the group | tested |
| Paths are checked as strings and again with `path.resolve` against the job directory | `src/validate.mjs`, `src/server.mjs` |
| The log has the job directory and cache path replaced with `<job>` and `<cache>` | tested |
| The process runs as uid 10001 (`app`); cache and style files are root-owned and read-only | `Dockerfile` |
| No secret is in the image or the container environment (`start({ env: {} })`) | `Dockerfile`, `examples/cloudflare-worker/container.ts` |

`--untrusted` does not block reads of absolute paths. A document can `\input` any file the process user can read, for example `/etc/hostname`, and Tectonic only prints a warning. File-read isolation therefore depends on the container holding nothing worth reading. The compiler runs as the same user as the server; a second uid for the compiler is not implemented, because capabilities of a non-root user in a deployed container are unverified (the Cloudflare local-dev notes say deployed processes have root's capabilities).

`execFile` does not pass the `detached` option to the child, so the server calls `spawn` with `shell: false` and an argument vector. The effect is the same: no shell parses the arguments.

## Run it locally without Docker

You need a Tectonic 0.17.0 binary and a Tectonic cache that holds the packages. Without a cache the first compile downloads from the 2.9 GB bundle, which takes minutes.

```sh
npm install
npm run vendor                                    # optional: the Jupiter style
export TECTONIC_BIN=/path/to/tectonic
export TECTONIC_CACHE_DIR=/path/to/cache          # warm it first, see below
export JUPITER_DIR=$PWD/jupiter                   # omit when you did not vendor the style
node src/index.mjs

curl -s localhost:8080/health
curl -s -X POST localhost:8080/compile -H 'content-type: application/json' \
  -d '{"main":"\\documentclass{article}\\begin{document}Hello\\end{document}"}' -o hello.pdf
```

To warm a cache, run the warm-up script with network access: `TECTONIC_CACHE_DIR=/path/to/cache PATH=/dir/of/tectonic:$PATH sh warmup/warm.sh $PWD/jupiter 40`. It compiles `warmup/warmup-packages.tex` and `warmup/warmup-jupiter.tex`, repeats them with `--only-cached` and fails when the cache is under 40 MB. It measured 46 MB in the first run.

### Tests

```sh
npm test
```

`test/server.test.ts` starts the server in-process on a random port. Most tests use a stub compiler, a Node script that behaves as the first line of `main.tex` says, so they need no Tectonic. The tests marked "with Tectonic" need the real binary and a warm cache: set `TECTONIC_BIN` and `TECTONIC_TEST_CACHE`. Without them the suite skips those tests and prints a warning. The tests copy the cache and make the copy read-only, as the image does. The Jupiter report test also needs `./jupiter` and `JUPITER_REPORT_TEX`, the path of `packages/latex/templates/report.tex` in the design repository.

## Build the image

Needs Docker and network access, and the Jupiter files in `./jupiter`.

```sh
npm run vendor
docker build --platform linux/amd64 -t tectonic-pdf-service .
```

The build fails when the SHA-256 of the Tectonic archive differs, when `tectonic --version` fails in the final image, when a warm-up document fails, or when the cache is under 40 MB. The SHA-256 in the Dockerfile comes from the archive downloaded on 2026-11-14. Confirm it against the release page before the first build.

## Run it on Cloudflare Containers

Containers needs the Workers Paid plan. The Worker reaches the container only through the Durable Object in `examples/cloudflare-worker/container.ts`, which holds the bearer token and starts the container with internet access off and no secrets in its environment.

1. Build and push the image: run the `image` workflow (manual trigger, needs the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), or run `docker build` and `npx wrangler containers push tectonic-pdf-service:<tag>` on a machine with Docker.
2. Add the container, the Durable Object binding and a migration to `wrangler.jsonc`. The Cloudflare documentation says not to mix `exports` with the older `migrations` array.

   ```jsonc
   "containers": [{
     "class_name": "PdfCompiler",
     "image": "./Dockerfile",
     "image_build_context": ".",
     "instance_type": "basic",
     "max_instances": 3
   }],
   "durable_objects": { "bindings": [{ "name": "PDF_COMPILER", "class_name": "PdfCompiler" }] },
   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PdfCompiler"] }],
   "vars": { "PDF_ENABLED": "on" }
   ```

   Use a migration tag that is new in your file. With a pushed image, set `image` to its `registry.cloudflare.com/...` reference so `wrangler deploy` needs no Docker. `max_instances` equals `PDF_POOL_SIZE` in `client.ts`.
3. Export the class from your Worker entry point: `export { PdfCompiler } from "./container.ts";`
4. Add `PDF_COMPILER`, `PDF_TOKEN` and `PDF_ENABLED` to your `Env` (the shapes are `PdfEnv` in `client.ts`), then call `compilePdf(env, { main, files })` from a route.
5. Set the secret: `npx wrangler secret put PDF_TOKEN` with a random value of at least 32 bytes.
6. Deploy. Wait several minutes after the first deploy: the Worker answers before the container routes do.
7. To turn it off, set `PDF_ENABLED` to anything but `on`. `compilePdf` then returns 501 without a network call.

## Not tested

Docker was not available, so these are untested:

- The image build: the Dockerfile, the SHA-256 pin, the `useradd`, the musl Tectonic binary on `node:22-slim`, the final image size (estimated at a few hundred MB, under the 4 GB `basic` disk).
- Fontconfig behaviour in the minimal image. The static binary printed fontconfig warnings on the dev machine. The Jupiter fonts load by file name, so system fonts should not matter.
- Running as uid 10001 against the root-owned read-only cache. The tests run as the developer user.
- `examples/cloudflare-worker/container.ts` against a real container: start, readiness poll, forwarding, inactivity timeout. It is type-checked only. The token comparison (`bearerMatches`) is tested.
- Whether `migrations` with `new_sqlite_classes` links the class to the `containers` entry.
- Request and response size between the Durable Object and the container; no documented limit.
- Cold start time and compile time on a `basic` instance (1/4 vCPU). Locally a report compiles in 2.9 s on a full core.
- The image workflow, the Cloudflare token permissions it needs, and the checkout of the design and docs repositories.
- The 28 MB raw request body cap (`MAX_BODY_BYTES`); the size-limit tests go through the per-file and total checks.
- SIGTERM drain during a rollout.

## Licence

MIT. See `LICENSE`. The Jupiter style files and fonts that `npm run vendor` copies keep the licences of their own repositories.
