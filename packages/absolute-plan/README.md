# `@pi-nema/absolute-plan`

`absolute-plan` adds a real planning mode for `pi`.

v2 behavior:
- `/plan` and `Alt+P` toggle planning mode.
- `ABSOLUTE_PLAN_AUTOENTER=1` only auto-enters planning mode; silent approval is now controlled separately via `ABSOLUTE_PLAN_AUTOAPPROVE=1`.
- planning mode is read-only and restricts active tools to discovery + planning tools.
- the agent maintains a structured `PlanDoc` through `set_plan`.
- plans are rendered to a canonical markdown file under `plans/`.
- `plan_exit` validates the plan, prepares an explicit review state on the markdown artifact, and only transitions after explicit approval.
- plan review is available through `/plan review`, `/plan approve`, `/plan revise`, and `/plan reject`, plus persisted review state in session history.
- compile assigns explicit per-task `complexity` and chooses `single` vs `swarm`.
- execution mode now runs either a single background subagent or an `absolute-swarm` task cell, and tracks follow-ups, blockers, and final verification.
- Stage 7 adds a narrow recovery layer: failed or blocked tasks get one fresh retry in an isolated git worktree, using `TaskBrief + FailureSummary` instead of the full raw transcript.
- successful retry attempts merge back into the main workspace as a patch/diff, rather than replacing the primary working tree.
- if a worker times out after successfully updating scoped files but before emitting the final JSON payload, `absolute-plan` can recover a synthetic `TaskResult` from persisted tool activity instead of immediately dropping the task as failed.
- recovery now normalizes absolute tool-result paths back to workspace-relative paths, so scoped-file recovery works against real external `pi` traces instead of only synthetic relative-path results.
- worker and verifier prompts now treat validation criteria as literal acceptance checks when they mention required headings, labels, or phrases.
- successful auto-enter execution now returns `DONE` and deactivates execution mode instead of leaving the main session in a DONE-only loop.
- execution observability is now surfaced through:
  - `/plan runs`
  - `/plan trace <runId>`
  - `/plan cell <taskId>`
  - and matching read-only tools for headless use.
- official debug policy is structured trace, not hidden thinking: persisted run state, task bindings, trace tail, stderr tail, and task-cell mailbox/blackboard snapshots are the supported interface.

Registered tools:
- `set_plan`
- `get_plan`
- `request_user_input`
- `compile_plan`
- `plan_exit`
- `get_task_graph`
- `get_runs`
- `get_run_trace`
- `get_cell_state`
- `task_update`
- `record_task_result`
- `pause_execution`
- `resume_execution`

Out of scope after Stage 7:
- public mailbox/blackboard tools
- researcher role in task cells
- session-level teams
- custom editor or input-color UI

Testing:
- `pnpm --filter @pi-nema/absolute-plan test`
- `pnpm --filter @pi-nema/absolute-plan typecheck`
- includes unit, runtime, and smoke-flow coverage with `vitest`

Operational note:
- long benchmark scenarios should be run sequentially, not in parallel, to avoid backend contention and false timeout signals.
