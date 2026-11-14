.. raw:: html

   <p align="right">
     <picture>
       <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/graphics/logo/jupiter-logo-dark.svg">
       <img alt="jupiter.au" src="https://raw.githubusercontent.com/belikh/design/latest/packages/graphics/logo/jupiter-logo-light.svg" width="260">
     </picture>
   </p>

   <h1>tectonic-pdf-service</h1>

.. meta::
   :description: HTTP service that compiles LaTeX to PDF with Tectonic in an isolated container, for Cloudflare Containers or any container host.

An HTTP service that compiles LaTeX to PDF with `Tectonic <https://tectonic-typesetting.github.io/>`_ 0.17.0 inside a container. It is built for Cloudflare Containers and called from a Worker through a Durable Object. The same image runs under any container host.

`Quick start`_ · `API`_ · `Assets`_ · `Isolation`_ · `Cloudflare`_ · `Contributing`_

The design follows the security notes in `How I Built a Secure LaTeX-to-PDF Service for Cloudflare Workers <https://hackernoon.com/how-i-built-a-secure-latex-to-pdf-service-for-cloudflare-workers>`_: shell escape off, a scrubbed environment, a temporary directory per job, rejected path escapes and a cap on concurrent compiles. This repository adds an offline package cache baked into the image and the Cloudflare Worker and Durable Object code.

Status: the server and the tests ran locally against a real Tectonic 0.17.0 binary. The Docker image, the Cloudflare deployment and the image workflow have not been built or run. See `Not tested`_.

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>


Quick start
-----------

Build and run the image (Docker and network access are needed for the build):

.. code-block:: sh

   docker build --platform linux/amd64 -t tectonic-pdf-service .
   docker run --rm -p 8080:8080 tectonic-pdf-service

   curl -s localhost:8080/health
   curl -s -X POST localhost:8080/compile -H 'content-type: application/json' \
     -d '{"main":"\\documentclass{article}\\begin{document}Hello\\end{document}"}' -o hello.pdf

The build needs no other repository. It fails when the SHA-256 of the Tectonic archive differs, when ``tectonic --version`` fails in the final image, when a warm-up document fails, or when the cache is under 40 MB. The SHA-256 in the Dockerfile comes from the archive downloaded on 2026-11-14. Confirm it against the release page before the first build.

|

Layout
------

.. |code-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/code-light.svg#gh-light-mode-only
   :width: 20
.. |code-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/code-dark.svg#gh-dark-mode-only
   :width: 20

.. |server-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/server-light.svg#gh-light-mode-only
   :width: 20
.. |server-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/server-dark.svg#gh-dark-mode-only
   :width: 20

.. |cloud-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/cloud-light.svg#gh-light-mode-only
   :width: 20
.. |cloud-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/cloud-dark.svg#gh-dark-mode-only
   :width: 20

.. |check-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/check-light.svg#gh-light-mode-only
   :width: 20
.. |check-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/check-dark.svg#gh-dark-mode-only
   :width: 20

.. |git-branch-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/git-branch-light.svg#gh-light-mode-only
   :width: 20
.. |git-branch-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/git-branch-dark.svg#gh-dark-mode-only
   :width: 20

.. |fonts-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/fonts-light.svg#gh-light-mode-only
   :width: 20
.. |fonts-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/fonts-dark.svg#gh-dark-mode-only
   :width: 20

.. |lock-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/lock-light.svg#gh-light-mode-only
   :width: 20
.. |lock-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/lock-dark.svg#gh-dark-mode-only
   :width: 20

.. |shield-l| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/shield-light.svg#gh-light-mode-only
   :width: 20
.. |shield-d| image:: https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/icon/shield-dark.svg#gh-dark-mode-only
   :width: 20

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Path
     - Contents
   * - |code-l| |code-d| ``src/``
     - The HTTP server (``server.mjs``), request validation (``validate.mjs``) and the entry point (``index.mjs``). Node built-ins only.
   * - |server-l| |server-d| ``Dockerfile``, ``warmup/``
     - Image build with a pinned Tectonic download, a package cache warmed at build time and a size check.
   * - |fonts-l| |fonts-d| ``assets/``
     - Optional files copied into every job: class files, fonts, images. Empty by default.
   * - |cloud-l| |cloud-d| ``examples/cloudflare-worker/``
     - ``client.ts`` (Worker client with a feature flag), ``container.ts`` (Durable Object that starts the container) and a test for the client.
   * - |check-l| |check-d| ``test/``
     - Server tests.
   * - |git-branch-l| |git-branch-d| ``.github/``
     - Test workflow, a manual workflow that builds the image and pushes it to the Cloudflare registry, Dependabot, issue and pull request templates.


.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>

API
---

The server listens on port 8080 (``PORT``). It reads no bearer token. Put authentication in front of it: in the Cloudflare example, a Durable Object checks a bearer token and is the only route into the container port.

.. list-table::
   :header-rows: 1
   :widths: 40 60

   * - Request
     - Answer
   * - ``GET /health``
     - ``200 {"status":"ok"}``
   * - ``POST /compile``
     - ``200 application/pdf``
   * - ``POST /compile``, compile failed or timed out
     - ``422 {"error": string, "log": string}``; ``log`` is the last 8 KB of the compiler output
   * - ``POST /compile``, bad request
     - ``400 {"error": string}``
   * - ``POST /compile``, over a size limit
     - ``413 {"error": string}``
   * - ``POST /compile``, more than 8 waiting
     - ``503 {"error": string}`` with ``Retry-After: 5``
   * - anything else
     - ``404``, or ``405`` for a wrong method

Request body for ``POST /compile``:

.. code-block:: json

   {
     "main": "\\documentclass{article} ...",
     "files": {
       "chapters/one.tex": "text content",
       "logo.png": { "encoding": "base64", "content": "iVBORw0KGgo..." }
     }
   }

``main`` is written as ``main.tex``. ``files`` is optional; each value is a UTF-8 string or a base64 object. There are no engine options.

**File names.** The server rejects with 400 a name that is empty, absolute, starts with a drive letter, contains a backslash or NUL, has a ``..`` segment, ends in ``/``, or equals ``main.tex`` (any case). It also rejects a name that duplicates another after normalisation, a name that is both a file and a directory, and a name that matches a file in the assets directory. It rejects; it does not repair.

**Limits.**

.. list-table::
   :header-rows: 1
   :widths: 40 25 35

   * - Limit
     - Value
     - Answer
   * - ``main``
     - 2 MB
     - 413
   * - One file (decoded)
     - 5 MB
     - 413
   * - Number of files
     - 50
     - 413
   * - Content in total, ``main`` included
     - 20 MB
     - 413
   * - Request body
     - 28 MB of JSON
     - 413
   * - Compile time
     - 60 s, then the process group is killed
     - 422
   * - Compiles at once
     - 2
     - queued
   * - Compiles waiting
     - 8
     - the 9th waiting request gets 503

The limits are in ``src/validate.mjs`` (sizes) and ``src/server.mjs`` (time and queue). The tests set shorter times through ``createApp`` options.

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>

Assets
------

Files in ``assets/`` are copied into the image at ``/opt/assets`` (``ASSETS_DIR``). The server copies them flat into every job directory before the request files, so ``\usepackage{mystyle}`` finds ``mystyle.sty`` and fonts load from the working directory. A request cannot replace them: a request file name that matches an asset name (any case) gets 400. Names that start with ``.`` (such as ``.gitkeep``) are skipped.

Add your class files, fonts and images to ``assets/`` before ``docker build``. To run without Docker, point ``ASSETS_DIR`` at any directory.

**Packages and the offline cache.** The compiler runs with ``--only-cached``, so a package that is not in the cache is an error. The image build fills the cache by compiling every ``warmup/*.tex`` with network access. If your documents use a package that ``warmup/warmup-packages.tex`` does not load, add a ``\usepackage`` line there or add a new ``warmup/*.tex`` file, then rebuild. Fonts that you use by file name belong in ``assets/``.

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>

Isolation
---------

.. list-table::
   :header-rows: 1
   :widths: 70 30

   * - Measure
     - Where
   * - Each job runs in a new ``mkdtemp`` directory (mode 0700) that is removed in ``finally``
     - ``src/server.mjs``
   * - ``--untrusted`` turns shell escape off. ``\write18`` prints "disabled" and runs nothing
     - tested
   * - ``--only-cached`` plus ``enableInternet: false``: a package missing from the cache is an error and there is no network path
     - ``src/server.mjs``, ``examples/cloudflare-worker/container.ts``
   * - The compiler environment holds PATH, HOME, TECTONIC_CACHE_DIR and TMPDIR only
     - tested with a document that reads ``/proc/self/environ``
   * - The compiler starts in its own process group; a timeout sends SIGKILL to the group
     - tested
   * - Paths are checked as strings and again with ``path.resolve`` against the job directory
     - ``src/validate.mjs``, ``src/server.mjs``
   * - The log has the job directory and cache path replaced with ``<job>`` and ``<cache>``
     - tested
   * - The process runs as uid 10001 (``app``); cache and asset files are root-owned and read-only
     - ``Dockerfile``
   * - No secret is in the image or the container environment (``start({ env: {} })``)
     - ``Dockerfile``, ``examples/cloudflare-worker/container.ts``

``--untrusted`` does not block reads of absolute paths. A document can ``\input`` any file the process user can read, for example ``/etc/hostname``, and Tectonic only prints a warning. File-read isolation therefore depends on the container holding nothing worth reading. The compiler runs as the same user as the server. A second uid for the compiler is not implemented: the capabilities of a non-root user in a deployed container are unverified, and the Cloudflare local-dev notes say deployed processes have root's capabilities.

``execFile`` does not pass the ``detached`` option to the child, so the server calls ``spawn`` with ``shell: false`` and an argument vector. The effect is the same: no shell parses the arguments.

To report a vulnerability, see ``SECURITY.md``.

|

Develop
-------

You need Node 22 or later. Without Docker you also need a Tectonic 0.17.0 binary and a Tectonic cache that holds the packages. Without a cache the first compile downloads from the 2.9 GB bundle, which takes minutes.

.. code-block:: sh

   npm install
   export TECTONIC_BIN=/path/to/tectonic
   export TECTONIC_CACHE_DIR=/path/to/cache          # warm it first, see below
   export ASSETS_DIR=$PWD/assets                     # optional
   node src/index.mjs

To warm a cache, run the warm-up script with network access:

.. code-block:: sh

   TECTONIC_CACHE_DIR=/path/to/cache PATH=/dir/of/tectonic:$PATH sh warmup/warm.sh $PWD/assets 40

It compiles every ``warmup/*.tex``, repeats them with ``--only-cached`` and fails when the cache is under 40 MB. It measured 46 MB.

**Tests.**

.. code-block:: sh

   npm test

``test/server.test.ts`` starts the server in-process on a random port. Most tests use a stub compiler, a Node script that behaves as the first line of ``main.tex`` says, so they need no Tectonic. The tests that need the real binary and a warm cache are skipped, with a warning, unless you set ``TECTONIC_BIN`` and ``TECTONIC_TEST_CACHE``. They copy the cache and make the copy read-only, as the image does. With a Tectonic binary and cache all 54 tests pass; without them 47 pass and 7 skip.

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>

Cloudflare
----------

Containers needs the Workers Paid plan. The Worker reaches the container only through the Durable Object in ``examples/cloudflare-worker/container.ts``, which holds the bearer token and starts the container with internet access off and no secrets in its environment.

1. Build and push the image: run the ``image`` workflow (manual trigger, needs the secrets ``CLOUDFLARE_API_TOKEN`` and ``CLOUDFLARE_ACCOUNT_ID``), or run ``docker build`` and ``npx wrangler containers push tectonic-pdf-service:<tag>`` on a machine with Docker.
2. Add the container, the Durable Object binding and a migration to ``wrangler.jsonc``. The Cloudflare documentation says not to mix ``exports`` with the older ``migrations`` array.

   .. code-block:: jsonc

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

   Use a migration tag that is new in your file. With a pushed image, set ``image`` to its ``registry.cloudflare.com/...`` reference so ``wrangler deploy`` needs no Docker. ``max_instances`` equals ``PDF_POOL_SIZE`` in ``client.ts``.
3. Export the class from your Worker entry point: ``export { PdfCompiler } from "./container.ts";``
4. Add ``PDF_COMPILER``, ``PDF_TOKEN`` and ``PDF_ENABLED`` to your ``Env`` (the shapes are ``PdfEnv`` in ``client.ts``), then call ``compilePdf(env, { main, files })`` from a route.
5. Set the secret: ``npx wrangler secret put PDF_TOKEN`` with a random value of at least 32 bytes.
6. Deploy. Wait several minutes after the first deploy: the Worker answers before the container routes do.
7. To turn it off, set ``PDF_ENABLED`` to anything but ``on``. ``compilePdf`` then returns 501 without a network call.

|

Not tested
----------

Docker was not available, so these are untested:

.. raw:: html

   <details><summary><b>Untested items</b></summary>

- The image build: the Dockerfile, the SHA-256 pin, the ``useradd``, the musl Tectonic binary on ``node:22-slim``, the final image size (estimated at a few hundred MB, under the 4 GB ``basic`` disk).
- Fontconfig behaviour in the minimal image. The static binary printed fontconfig warnings on the dev machine. Fonts that you load by file name should not depend on system fonts.
- Running as uid 10001 against the root-owned read-only cache. The tests run as the developer user.
- ``examples/cloudflare-worker/container.ts`` against a real container: start, readiness poll, forwarding, inactivity timeout. It is type-checked only. The token comparison (``bearerMatches``) is tested.
- Whether ``migrations`` with ``new_sqlite_classes`` links the class to the ``containers`` entry.
- Request and response size between the Durable Object and the container; no documented limit.
- Cold start time and compile time on a ``basic`` instance (1/4 vCPU).
- The image and test workflows on GitHub, and the Cloudflare token permissions the image workflow needs.
- The 28 MB raw request body cap (``MAX_BODY_BYTES``); the size-limit tests go through the per-file and total checks.
- SIGTERM drain during a rollout.

.. raw:: html

   </details>

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>

Contributing
------------

See ``CONTRIBUTING.md`` for setup, tests and the pull request checklist. Participation follows ``CODE_OF_CONDUCT.md``. Accessibility goals and known limits are in ``ACCESSIBILITY.md``.

Licence
-------

MIT. See ``LICENSE``. Files that you put in ``assets/`` keep their own licences.

|

.. raw:: html

   <p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-dark.svg"><img alt="" src="https://raw.githubusercontent.com/belikh/design/latest/packages/github/graphics/rule/end-light.svg" width="50%"></picture></p>


.. raw:: html

   <p align="right"><sub>jupiter.au</sub></p>
