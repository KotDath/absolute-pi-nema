# `@pi-nema/absolute-swarm`

Internal task-cell runtime for collaborative execution.

v1 behavior:
- provides bounded task cells with `implementer`, `critic`, and `verifier`;
- maintains internal `mailbox` and `blackboard` state;
- exposes `createCell`, `runCell`, `readCellState`, `stopCell`, and `collectCellResult`;
- is designed for orchestrators such as `absolute-plan`, not as a user-facing tool surface;
- accepts task-local retry context via `taskBrief` and optional `failureSummary`, so Stage 7 can restart a whole cell in a fresh worktree without replaying the full plan transcript.

Out of scope in v1:
- public mailbox or blackboard tools
- full session-level teams
- researcher role
- role-level selective restarts

Testing:
- `pnpm --filter @pi-nema/absolute-swarm test`
- `pnpm --filter @pi-nema/absolute-swarm typecheck`
