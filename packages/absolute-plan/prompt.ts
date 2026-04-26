import type { PlanModeState } from "./types.js";

export function buildPlanningPrompt(state: PlanModeState): string {
	const goal = state.plan?.goal ? `Current goal: ${state.plan.goal}` : "Current goal: not captured yet.";
	const planFilePath = state.planFilePath ? `Plan file: ${state.planFilePath}` : "Plan file: not assigned.";
	const feedback =
		state.feedback && state.feedback.trim().length > 0
			? `Latest review feedback: ${state.feedback}`
			: "Latest review feedback: none.";

	return `
You are in planning mode.

Rules:
- Planning mode is read-only. Never use write, edit, or bash.
- Use read, list_directory, grep_search, and glob to inspect the workspace.
- Maintain the canonical structured plan via set_plan. Always send the full latest plan object.
- Use get_plan when you need to recover current plan state after interruptions.
- Use request_user_input when repository inspection is not enough and you need explicit user intent.
- Use plan_exit only after the plan is valid, specific, and ready for approval and execution handoff. If the latest review feedback is non-empty, address it before asking for approval again.
- In non-interactive runs, plan_exit without an explicit decision will auto-approve and start execution.
- In interactive runs, do not self-approve on the user's behalf. Ask for review and let the runtime collect the decision.

Plan requirements:
- The plan must include goal, files, assumptions, openQuestions, items, verification, risks, and status.
- Each item needs a stable id, concrete title, explicit outcome, explicit validation, and dependencies when relevant.
- For code or file-oriented tasks, each item should include item.files with the specific files that item is allowed to touch.
- Avoid broad items that implicitly touch the whole project when the work can be decomposed by file or module.
- Prefer executionMode based on task complexity. Use swarm for higher-risk or broader tasks.
- Include verification steps that mention tests or checks.
- Keep the plan concise but implementation-ready. Avoid vague steps.

${goal}
${planFilePath}
${feedback}
`.trim();
}

export function buildExecutionPrompt(state: PlanModeState): string {
	const goal = state.compiledTaskGraph?.goal || state.plan?.goal || "Execution goal not available.";
	const planFilePath = state.planFilePath ? `Plan file: ${state.planFilePath}` : "Plan file: not assigned.";
	const completionDirective =
		state.status === "completed"
			? "Execution is already complete and verification passed. Reply with DONE only. Do not call any tools."
			: "If execution is still running, do not attempt implementation yourself. Use get_task_graph or get_plan for status, then wait instead of improvising new work.";

	return `
You are in execution mode.

Rules:
- Do not manually implement tasks in the main session.
- Do not use read, write, edit, bash, grep_search, glob, or list_directory from the main session during execution.
- The execution loop and subagents handle implementation automatically.
- The main session never performs step-by-step execution like checking tools, running bash, or editing files. Workers do that in the background.
- Use only execution control tools: get_task_graph, get_plan, get_runs, get_run_trace, get_cell_state, pause_execution, resume_execution, record_task_result when explicitly needed.
- Only consider the task done when the task graph is complete and verification has passed.
${completionDirective}

Current execution goal: ${goal}
${planFilePath}
`.trim();
}
