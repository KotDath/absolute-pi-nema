# Bench Layout

This directory separates benchmark data from benchmark runners.

- `fixtures/` contains file trees copied into a temporary workspace per scenario.
- `skills/` contains local synthetic skills used by skill-focused scenarios.
- `scenarios/` contains JSON scenario specs.
- `scripts/run-bench.mjs` is the thin runner that launches real `pi` processes against those specs.
- each scenario run writes `trace.jsonl` and `metrics.json` into its temporary workspace

The current format is intentionally small but future-proof:

- scenarios are data, not hard-coded test functions
- the runner launches `pi` with explicit `--extension` paths, so fixture cwd can differ from the extension repo cwd
- each scenario can later grow extra metadata for harder evals, larger repos, or SWE-bench style tasks

## Scenario Shape

```json
{
  "id": "read-file-basic",
  "suite": "smoke",
  "fixture": "read-file-basic",
  "prompt": "Use read on {{fixtureRoot}}/package.json and answer with packageManager only.",
  "pi_args": ["--thinking", "low"],
  "checks": {
    "must_use_tools": ["read"],
    "must_not_use_tools": ["bash"],
    "must_error_tools": ["write"],
    "must_not_error_tools": ["read"],
    "final_text_includes": ["pnpm@10.33.0"],
    "final_text_regex": "^pnpm@",
    "files_exact": [
      {
        "path": "sample.txt",
        "content": "expected\\n"
      }
    ]
  }
}
```

## Template Variables

- `{{fixtureRoot}}` - absolute path to the temporary workspace for this scenario
- `{{repoRoot}}` - absolute path to this repository root

`prompt` and `pi_args` both support these template variables.

## Commands

- `pnpm bench:list`
- `pnpm bench`
- `pnpm bench:smoke`
- `pnpm bench:guardrails`

## Model Selection

The runner uses the default locally available `pi` model/provider unless overridden.

## Token Metrics

For each scenario, the runner aggregates usage from assistant messages and reports:

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `totalTokens`

These metrics are shown in console output and also stored in `metrics.json` next to the captured `trace.jsonl`.

Optional environment overrides:

- `PI_BENCH_PROVIDER`
- `PI_BENCH_MODEL`
