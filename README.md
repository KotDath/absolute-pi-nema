<div align="center">

# absolute-pi-nema

**Absolute-path extensions for [pi](https://github.com/badlogic/pi-mono) with qwen-style semantics on a pi-compatible tool surface.**

Local-first extension pack for `pi`:
`read`, `write`, `edit`, `bash`, `list_directory`, `grep_search`, `glob`.

</div>

---

## 30-Second Start

There is **no published npm package yet**.

Install from a local checkout instead:

```bash
git clone <your-fork-or-local-remote> absolute-pi-nema
cd absolute-pi-nema
pnpm install
pi install ./packages/absolute-qwen
```

Then start `pi` normally.

## Start Here

Use this reading path depending on what you want to do:

- **I want the Qwen-style tools in pi**: install `./packages/absolute-qwen`, then skim the package table below.
- **I want to try local changes safely**: run `pnpm install`, `pnpm typecheck`, `pnpm test`, then `pnpm bench:smoke`.
- **I want to work on the benchmark harness**: start with [bench/README.md](./bench/README.md), then inspect `scripts/run-bench.mjs`.
- **I want to contribute**: read [AGENTS.md](./AGENTS.md) first for repo-specific validation rules.

### Architecture At A Glance

```text
absolute-pi-nema
├── packages
│   ├── absolute-qwen
│   │   └── qwen-style coding tools for pi
│   └── absolute-plan
│   │   └── minimal plan-mode extension placeholder
│   └── absolute-web
│       └── keyless web search and content fetching
├── bench
│   ├── fixtures
│   └── scenarios
└── scripts
    └── real-agent benchmark runner
```

## Packages

This is a small monorepo. Right now the only package most users need is `absolute-qwen`.

| Package | Role | Install |
| ------- | ---- | ------- |
| [`@pi-nema/absolute-qwen`](./packages/absolute-qwen) | Qwen-style coding tools for `pi` with bounded reads/searches and hardened tool contracts | `pi install ./packages/absolute-qwen` |
| [`@pi-nema/absolute-plan`](./packages/absolute-plan) | Minimal plan-mode extension placeholder | `pi install ./packages/absolute-plan` |
| [`@pi-nema/absolute-web`](./packages/absolute-web) | Keyless DuckDuckGo/Exa web search and readable URL fetching | `pi install ./packages/absolute-web` |

## Local Install

Because there is **no npm release yet**, install from this checkout with local paths.

### Install `absolute-qwen`

From the repo root:

```bash
pi install ./packages/absolute-qwen
```

Project-local instead of global:

```bash
pi install -l ./packages/absolute-qwen
```

From outside the repo, install with an absolute path:

```bash
pi install /absolute/path/to/absolute-pi-nema/packages/absolute-qwen
```

### Install `absolute-plan`

```bash
pi install ./packages/absolute-plan
```

Project-local:

```bash
pi install -l ./packages/absolute-plan
```

### Install `absolute-web`

```bash
pi install ./packages/absolute-web
```

Project-local:

```bash
pi install -l ./packages/absolute-web
```

### Install Both Packages

```bash
pi install ./packages/absolute-qwen
pi install ./packages/absolute-plan
pi install ./packages/absolute-web
```

## Configure In `settings.json`

`pi` supports both:

- package-style loading via `packages`
- direct file or directory loading via `extensions`

Settings files:

- global: `~/.pi/agent/settings.json`
- project-local: `.pi/settings.json`

### Recommended: package-style config

This is the cleaner option if you want `pi` to treat `absolute-qwen` as a local package:

```json
{
  "packages": [
    "/home/kotdath/omp/personal/js/absolute-pi-nema/packages/absolute-qwen"
  ]
}
```

Add `absolute-plan` too if you want both:

```json
{
  "packages": [
    "/home/kotdath/omp/personal/js/absolute-pi-nema/packages/absolute-qwen",
    "/home/kotdath/omp/personal/js/absolute-pi-nema/packages/absolute-plan",
    "/home/kotdath/omp/personal/js/absolute-pi-nema/packages/absolute-web"
  ]
}
```

### Direct extension-file config

If you want to load the extension entry file directly without going through package loading:

```json
{
  "extensions": [
    "/home/kotdath/omp/personal/js/absolute-pi-nema/packages/absolute-qwen/index.ts"
  ]
}
```

After editing `settings.json`, restart `pi` or run `/reload`.

### Which one should I use?

- Use `packages` if you want the normal `pi` package path and cleaner long-term config.
- Use `extensions` if you want to point directly at `index.ts` during local development.

## What `absolute-qwen` Changes

`absolute-qwen` replaces the default mental model with a more explicit tool surface:

- `read`: bounded paginated reads with continuation hints
- `write`: summary-first writes with overwrite guardrails
- `edit`: exact-match edits with diff previews
- `bash`: streaming shell execution with full-log spooling
- `grep_search`: bounded summary-first regex search
- `glob`: pattern-based file discovery
- `list_directory`: bounded directory listing with truncation metadata

The canonical overlapping names are `read`, `write`, and `bash`, but their descriptions keep qwen-style semantic aliases such as `read_file`, `write_file`, and `run_shell_command`.

The package is tuned for:

- absolute file paths
- search-first, then read targeted ranges
- real-agent validation through fixture-based benches

## Development

Requirements:

- Node.js `>=20`
- `pnpm`
- `pi`

Install dependencies:

```bash
pnpm install
```

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm bench:smoke
pnpm bench
```

## Validation

Recommended validation flow for tool changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm bench
```

`pnpm test` covers local regression tests.
`pnpm bench` launches a real `pi` agent, captures tool traces, and checks behavior against fixture-based scenarios.

## Compatibility

- Runtime target: `@mariozechner/pi-* >=0.67.0`
- Development in this repo is currently pinned to `0.67.68`
- The benchmark harness passes extension paths explicitly with `--extension`, which keeps local validation deterministic

## Benchmarks

The repo includes a small real-agent benchmark harness under [`bench/`](./bench) and [`scripts/`](./scripts).

- `bench/scenarios/`: scenario specs
- `bench/fixtures/`: workspace templates copied into temp dirs
- `scripts/run-bench.mjs`: runner for `pi --mode json`

Design rule: benchmark prompts should stay close to realistic user requests. If a scenario is broken, fix the expectation or the harness, not the prompt wording just to help the agent pass.
