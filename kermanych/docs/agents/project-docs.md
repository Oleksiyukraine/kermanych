# Project docs (`project-docs` MCP server, docs-harness)

The project's own specs, plans, runbooks and design mockups are indexed by
[docs-harness](https://github.com/andygo-develop/docs-harness) and served through the
`project-docs` MCP server. Before you assume how a feature is meant to behave, search them.

- `search_project_docs` takes `query`, an optional `limit` (default 5, max 25) and optional
  `tags`. It returns short excerpts, each with a `documentId`.
- `get_project_doc` takes a `documentId` and returns that one section in full. Fetch a section
  only when its excerpt looks relevant. Don't read whole files when a section is enough.

Narrow searches with `tags`. A result matches if it carries at least one of the tags you pass:

| Tag | What it covers |
|---|---|
| `spec` | Design specs: what a feature should do and why (`docs/specs/`, `docs/superpowers/specs/`) |
| `plan` | Implementation plans broken into tasks (`docs/superpowers/plans/`) |
| `findings` | What an increment actually turned up (`*-findings.md` in plans) |
| `guide` | Runbooks and how-tos (`docs/*.md`) |
| `design` | UI mockups and the design system (`design/*.html`) |
| `docs` | Everything under `docs/` |

Use `spec` for intended behaviour and `plan`/`findings` for how it was built. Use `design` for
UI work. Design files are indexed as raw bundled HTML, so their excerpts are noisy. Use them to
find the right mockup, then open the file itself.

The docs describe this project only. Don't present them as the documented behaviour of a
third-party library. If a doc contradicts the code, trust the code and say so.

When you add or rename docs, or change `docs.include` tags in `.docs-harness/config.json`,
re-index:

```bash
docs-harness docs index           # incremental; --rebuild to start over
docs-harness docs search "<query>" --tag spec
docs-harness docs status          # is the index current?
```
