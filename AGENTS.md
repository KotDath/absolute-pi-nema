# absolute-pi-nema

This repository contains local `pi` extensions.

## What Is Here

- `packages/absolute-qwen/`
  Pi-compatible coding tools with qwen-style semantics: `read`, `write`, `edit`, `bash`, `list_directory`, `grep_search`, `glob`.
- `packages/absolute-plan/`
  Placeholder plan-mode extension. It is present in the extension list but is intentionally minimal right now.
- `packages/absolute-web/`
  Keyless web search and content fetching tools for `pi`: `web_search`, `fetch_content`, `get_web_content`.
- `scripts/`
  Runner scripts for real `pi` smoke/bench execution.
- `bench/`
  Data-driven benchmark scenarios and fixture templates. See `bench/README.md` for the scenario format.

## Runtime Notes

- This workspace targets `@mariozechner/pi-* >=0.67.0`.
- The root `package.json` registers both local extensions through the `pi.extensions` field.
- The benchmark runner does **not** rely on fixture cwd discovery. It passes extension paths explicitly with `--extension`, which makes it suitable for future heavier eval suites.

## Common Commands

- Install dependencies:
  `pnpm install`
- Typecheck all packages:
  `pnpm typecheck`
- Run unit/regression tests:
  `pnpm test`
- Run lint:
  `pnpm lint`
- Run the real-agent smoke benchmark suite:
  `pnpm bench:smoke`
- List available benchmark scenarios:
  `pnpm bench:list`
- Run all benchmark scenarios:
  `pnpm bench`

## Recommended Validation Flow

For changes in `absolute-qwen` tools, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm bench:smoke
```

`pnpm test` covers local regression tests. `pnpm bench:smoke` launches a real `pi` agent and checks tool usage plus final outcomes against fixture-based scenarios.

## Bench Design

- `bench/fixtures/` contains template workspaces copied to a temp directory per scenario.
- `bench/scenarios/` contains JSON specs with prompts and assertions.
- `scripts/run-bench.mjs` is the thin runner that launches `pi --mode json`, captures the trace, verifies tool calls/final outputs, and records token usage metrics.
- Bench prompts should stay close to realistic user requests. Fix broken expectations in scenarios, but do not strengthen prompts just to help the agent pass. If a scenario is flaky because of harness details, stabilize the harness instead of adding extra hints to the prompt.

This layout is intentionally simple now, but it is meant to scale toward larger eval suites later.
