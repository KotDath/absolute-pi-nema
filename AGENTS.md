# absolute-pi-nema

This repository contains local `pi` extensions.

## What Is Here

- `packages/absolute-qwen/`
  Qwen-style coding tools for `pi`: `read_file`, `write_file`, `edit`, `run_shell_command`, `list_directory`, `grep_search`, `glob`.
- `packages/absolute-plan/`
  Placeholder plan-mode extension. It is present in the extension list but is intentionally minimal right now.
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
- `scripts/run-bench.mjs` is the thin runner that launches `pi --mode json`, captures the trace, and verifies tool calls, final text, and file outputs.

This layout is intentionally simple now, but it is meant to scale toward larger eval suites later.
