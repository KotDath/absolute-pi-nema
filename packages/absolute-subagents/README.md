# `@pi-nema/absolute-subagents`

`absolute-subagents` provides a process-based subagent runtime for `pi`.

v1 behavior:
- `spawn_agent` launches foreground or background runs with isolated session directories.
- `send_agent_message` queues follow-up work for background runs and resumes completed runs.
- `wait_agent`, `stop_agent`, and `list_agents` operate on persisted run state under `.absolute-subagents/`.
- each run stores config, inbox, state, result, and event artifacts in a run directory.

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
