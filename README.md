# Ferrite agent-readiness scanners

Three command-line tools that measure how well a website serves AI agents. Each one sends real requests to one origin and judges what comes back: whether `robots.txt`, `llms.txt` and the sitemap are there, whether pages have Markdown twins, whether the API catalogue and agent card are valid, whether the MCP endpoint answers, and whether errors and payment challenges follow their standards.

The tools are plain Node.js ES modules. They have no npm dependencies and no build step, and they work against any website, whether or not it runs on Ferrite.

| Tool | What it reports |
| --- | --- |
| `agent-score` | One weighted score out of 100 with a letter grade, from a single battery of checks |
| `agent-scan` | A tiered report of 20 checks in three pools: essential (80 points), recommended (20 points) and bonus (up to 5 points). It imports the `agent-score` checks unchanged and adds seven of its own, so the two tools agree on every shared verdict |
| `agent-conformance` | Fourteen named scenarios in five tiers (`READABLE`, `CALLABLE`, `PAYABLE`, `PROTOCOL`, `RESILIENCE`), each made of checks with captured evidence, judged against a baseline of expected failures |

`served-surface/` holds the modules the three tools share: the MCP client, the wire parsing and the in-process fixtures the tests run against.

## Run a scan

```bash
node agent-score/agent-score.mjs scan https://example.com --name example
node agent-scan/agent-scan.mjs scan https://example.com --md
node agent-conformance/agent-conformance.mjs scan https://example.com --name example --baseline agent-conformance/baseline.yml
```

With `--out DIR`, `agent-score` and `agent-scan` write `<name>.report.json` and `<name>.report.md` into that directory, and `agent-conformance` writes `<name>.conformance.json` and `<name>.conformance.md`.

The MCP checks call a tool on the origin only when you say which tools are safe to call. Pass `--mcp-profile FILE`, where the file is a served-surface profile (`schema_version` `served-surface-profile.v1`) that states the endpoint's protocol revision and an explicit `read_only_tool_allowlist`; `served-surface/evidence.mjs` validates it. Without a profile the MCP checks are reported as unverified and earn no credit.

## Reading the results

A check answers `pass`, `fail` or `info`. `info` means the check does not apply to the origin, for example a payment check on a site that charges for nothing, and it is not counted as a pass.

`agent-conformance` enforces its baseline in both directions. A failing check that the baseline does not list is a regression, and a listed failure that has started passing is a stale entry; either one makes the run exit 1. The exit code is 0 for a clean run and 2 when the evidence is missing, for example because the origin did not answer.

A result describes what one origin served at the moment it was scanned.

## Tests

The suites run against origins started inside the test process, so they need no network:

```bash
node --test agent-score/agent-score.test.mjs agent-scan/test.mjs agent-conformance/agent-conformance.test.mjs
```

They need Node.js 20 or later.

## Licence and contributions

Apache-2.0; see `LICENSE` and `NOTICE`. This repository accepts issues and does not accept outside pull requests; see `CONTRIBUTING.md`. Report a security problem to security@ferrite.cloud, as `SECURITY.md` describes. The hosted Ferrite platform is proprietary and not open source.

This repository is a scrubbed public snapshot prepared by the Ferrite team and carries no private development history.
