# Accessibility

This project is an HTTP service and has no user interface. These parts reach people:

- **Documentation** (`README.rst`, `CONTRIBUTING.md`, this file): headings in order, descriptive link text, code blocks with a named language, tables with header rows, no information carried by colour or images alone. The README logo and dividers are decorative or have `alt` text.
- **Responses**: errors are JSON (`{"error": string}`) with an HTTP status code. They never rely on colour or formatting.
- **PDF output**: Tectonic produces untagged PDFs. A PDF made from a plain `article` document has no `/StructTreeRoot` and no `/Lang` entry, so screen readers get no reading order or language. Tectonic 0.17.0 has no tagged-PDF mode that this service enables.

## Known limitations

- Output PDFs are not tagged. Callers who need accessible PDFs must post-process them or use another toolchain.
- The Dockerfile, workflows and test output are text only and have not been checked with a screen reader.

## Report a problem

Open an issue with the **Accessibility** template. Describe the barrier, the tool you used and the page or output affected. Pull requests that improve these areas are welcome, and the pull request template has an accessibility item.
