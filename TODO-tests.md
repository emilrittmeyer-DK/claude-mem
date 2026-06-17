# Test Coverage — Follow-up TODO

Tracks remaining work after the test-coverage improvement effort on
`claude/test-coverage-analysis-izxf18` (PR #3). The baseline suite is green and
isolated (1341 pass / 0 fail); items below are deferred or pending a decision.

> Note: the container starts without `node_modules`; run `bun install` before
> `bun test`.

## Flagged — pending decision

- [ ] **🔒 Privacy gap: summarize `last_assistant_message` is not tag-stripped.**
  Prompts and observations are stripped (`SessionRoutes` lines ~553/557/740), but
  the summarize path passes `last_assistant_message` straight to `queueSummarize`
  (`SessionRoutes` ~597–623 and ~428–430), and the hook handler
  (`src/cli/handlers/summarize.ts`) doesn't strip it either. So `<private>`
  content can reach the summarizer LLM (possibly external) and stored summaries.
  Fix at the edge (`stripMemoryTagsFromPrompt` in the hook handler), optionally
  also defensively in `SessionRoutes`. Then activate the skipped spec in
  `tests/services/worker/validation/privacy-check-validator.test.ts`.

## Deferred test packages (larger harness work)

- [ ] **SDKAgent** (`src/services/worker/SDKAgent.ts`) — needs a stubbed Anthropic
  Agent SDK `query()` (subprocess). Mirror the agent mock approach in
  `tests/gemini_agent.test.ts` / `tests/worker/openrouter-agent.test.ts`.
- [ ] **SearchManager** (`src/services/worker/SearchManager.ts`) — exercise the
  high-value pure logic (`normalizeParams`) and the SQLite filter-only path with
  an in-memory DB + mocked Chroma/orchestrator.

## Nice-to-have

- [ ] **ChromaSync** batching / `addDocuments` / `sync*` via a mocked
  `ChromaMcpManager` (the format/sanitization logic is already covered in
  `tests/services/sync/chroma-sync-format.test.ts`).
- [ ] **Transcripts watcher/processor** integration tests (`fs.watch`, temp dir,
  fake clock). Pure `field-utils` is already covered.
- [ ] **`/api/stats`** route test — needs `getPackageRoot` mocked (resolves to
  `src/` under the test runner, so it currently 500s; excluded from
  `tests/worker/http/data-memory-routes.test.ts`).
- [ ] **Remaining HTTP routes** — `SettingsRoutes` (validation; mock `process.exit`),
  `SearchRoutes`, and `SessionRoutes` lifecycle, using the
  `new Server(...)` / port-0 mount harness.

## Process

- [ ] **Greptile** "required keyword not found" on PR #3 is greptile's own
  server-side config (no in-repo config); supply the keyword if greptile review
  is wanted.
- [ ] PR #3 is a draft, ready for review/merge once the above are triaged.

## Done (for reference)

- WP0 green + isolated baseline (fixed 58 failures: stale MarkdownFormatter +
  `mock.module` pollution; added env/cwd isolation harness; closed the
  logger/project-filter/SettingsDefaultsManager mock-leak class).
- WP1 CLI adapters, WP2 CLI handlers, WP3 HTTP data/memory routes,
  WP4 OpenRouterAgent, WP5 transcripts field-utils, WP6 PrivacyCheckValidator,
  WP7 ChromaSync formatting, WP8 smart-file-read parser.
- Hardening: summarize handler try/catch; rawAdapter null-input guard.
