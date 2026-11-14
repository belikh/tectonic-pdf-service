# Security policy

## Report a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/belikh/tectonic-pdf-service/security/advisories/new). Do not open a public issue.

Include the request or document that triggers the problem, the image or commit you tested, and the effect you observed. Expect a first reply within 7 days. A fix and a coordinated disclosure date follow from the severity.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases yet.

## Scope

In scope: escaping the job directory, running a command from a document, reading the server environment, bypassing size or time limits, and leaking server paths in responses.

Known and out of scope: Tectonic's `--untrusted` mode does not block reads of absolute paths, so a document can read any file the container user can read. The README states this under "Isolation". The container should hold nothing worth reading.

The server has no authentication. Put it behind an authenticated proxy, as the Cloudflare example does.
