# `@pi-nema/absolute-plan`

`absolute-plan` adds a real planning mode for `pi`.

v2 behavior:
- `/plan` and `Alt+P` toggle planning mode.
- planning mode is read-only and restricts active tools to discovery + planning tools.
- the agent maintains a structured `PlanDoc` through `set_plan`.
- plans are rendered to a canonical markdown file under `plans/`.
- `plan_exit` validates the plan, shows approval on the markdown artifact, compiles the plan into a `TaskGraph`, and transitions into execution mode.
- compile assigns explicit per-task `complexity` and chooses `single` vs `swarm`.
- execution mode now runs either a single background subagent or an `absolute-swarm` task cell, and tracks follow-ups, blockers, and final verification.

Registered tools:
- `set_plan`
- `get_plan`
- `request_user_input`
- `compile_plan`
- `plan_exit`
- `get_task_graph`
- `task_update`
- `record_task_result`
- `pause_execution`
- `resume_execution`

Out of scope after Stage 6:
- public mailbox/blackboard tools
- researcher role in task cells
- Ralph-style retries
- custom editor or input-color UI

Testing:
- `pnpm --filter @pi-nema/absolute-plan test`
- `pnpm --filter @pi-nema/absolute-plan typecheck`
- includes unit, runtime, and smoke-flow coverage with `vitest`
