# Rust Workspace Audit CLI

Design and scaffold a Rust CLI named `workspace-audit`.

Required deliverables:

1. `Cargo.toml`
   - package name `workspace-audit`
   - dependencies: `clap`, `serde`, `serde_json`, `toml`, `anyhow`
2. `src/main.rs`
   - use `#[derive(Parser)]`
   - define subcommands `scan`, `explain`, and `fix-plan`
3. `src/report.rs`
   - define `pub struct AuditReport`
   - define a serializable finding type
4. `docs/architecture.md`
   - include sections:
     - `## Scanning pipeline`
     - `## Rule engine`
     - `## JSON output contract`
5. `README.md`
   - include a quickstart
   - mention each subcommand

Constraints:

- Do not download dependencies or run cargo commands.
- Keep the code implementation-oriented, not purely aspirational.
- Write concrete file contents.
