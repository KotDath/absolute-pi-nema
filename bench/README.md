# Bench Layout

This directory separates benchmark data from benchmark runners.

- `fixtures/` contains file trees copied into a temporary workspace per scenario.
- `scenarios/` contains JSON scenario specs.
- `scripts/run-bench.mjs` is the thin runner that launches real `pi` processes against those specs.

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
  "prompt": "Use read_file on {{fixtureRoot}}/package.json and answer with packageManager only.",
  "pi_args": ["--thinking", "low"],
  "checks": {
    "must_use_tools": ["read_file"],
    "must_not_use_tools": ["run_shell_command"],
    "must_error_tools": ["write_file"],
    "must_not_error_tools": ["read_file"],
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

## Commands

- `pnpm bench:list`
- `pnpm bench`
- `pnpm bench:smoke`
- `pnpm bench:guardrails`

## Model Selection

The runner uses the default locally available `pi` model/provider unless overridden.

Optional environment overrides:

- `PI_BENCH_PROVIDER`
- `PI_BENCH_MODEL`
