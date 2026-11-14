# Contributing

Bug reports, fixes, documentation changes and small features are welcome. This is a personal project, so replies can take a few days.

## Set up

You need Node 22 or later.

```sh
git clone https://github.com/belikh/tectonic-pdf-service.git
cd tectonic-pdf-service
npm install
npm test
```

`npm test` runs without Tectonic or Docker: the tests that need the real compiler are skipped. To run them, set `TECTONIC_BIN` (a Tectonic 0.17.0 binary) and `TECTONIC_TEST_CACHE` (a warm cache). `README.rst` explains how to warm one with `warmup/warm.sh`.

## Pull requests

1. Open an issue first for anything larger than a bug fix, so the direction can be agreed before you write code.
2. Fork the repository and create a branch.
3. Keep the change small and focused. Add or update a test for each behaviour change.
4. Run `npm test` and fix every failure.
5. Describe what changed and why. Link the issue.

## What fits

- Bug fixes and documentation corrections.
- Changes that tighten isolation or limits, with a test that shows the effect.
- Small, self-contained features.

## What does not fit

- New runtime dependencies. The server uses Node built-ins only.
- Engine options in the request body, or a network path for the compiler.
- Breaking changes to the API without an issue that discusses them.

## Code and writing style

Follow the existing style in `src/`. Write comments and docs in plain, specific sentences: say what a thing does, with numbers and names.

## Accessibility

The service has no user interface. Its error messages are plain text and JSON, and its documentation is plain text. Keep both readable: use headings in order, descriptive link text, and text that does not depend on colour. See `ACCESSIBILITY.md`.

## Security

Do not open a public issue for a vulnerability. See `SECURITY.md`.

## Conduct

This project follows the Contributor Covenant. See `CODE_OF_CONDUCT.md`.
