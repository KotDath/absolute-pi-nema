# `@pi-nema/absolute-subagents`

`absolute-subagents` provides a process-based subagent runtime for `pi`.

v1 behavior:
- `spawn_agent` launches foreground or background runs with isolated session directories.
- `send_agent_message` queues follow-up work for background runs and resumes completed runs.
- `wait_agent`, `stop_agent`, and `list_agents` operate on persisted run state under `.absolute-subagents/`.
- each run stores config, inbox, state, result, and event artifacts in a run directory.
- each run also persists external-session observability artifacts such as `trace.jsonl` and `stderr.log`, so planning/execution layers can inspect what happened inside worker or verifier runs.
- runtime timeouts now distinguish between:
  - total turn timeout; and
  - idle timeout when a subagent stops producing output mid-turn.
- idle turns fail fast instead of consuming the full wall-clock budget, which matters for long local-model benchmark tasks.

Registered tools:
- `spawn_agent`
- `send_agent_message`
- `wait_agent`
- `stop_agent`
- `list_agents`

Out of scope in v1:
- task orchestration
- mailbox/blackboard
- swarm/task-cell coordination
- dedicated `resume_agent` tool

Testing:
- `pnpm --filter @pi-nema/absolute-subagents test`
- includes unit, runtime, and smoke coverage
