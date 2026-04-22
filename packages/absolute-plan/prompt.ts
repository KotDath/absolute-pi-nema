import type { PlanModeState } from "./types.js";

export function buildPlanningPrompt(state: PlanModeState): string {
	const goal = state.plan?.goal ? `Current goal: ${state.plan.goal}` : "Current goal: not captured yet.";
	const planFilePath = state.planFilePath ? `Plan file: ${state.planFilePath}` : "Plan file: not assigned.";

	return `
You are in planning mode.

Rules:
- Planning mode is read-only. Never use write, edit, or bash.
- Use read, list_directory, grep_search, and glob to inspect the workspace.
- Maintain the canonical structured plan via set_plan. Always send the full latest plan object.
- Use get_plan when you need to recover current plan state after interruptions.
- Use request_user_input when repository inspection is not enough and you need explicit user intent.
- Use plan_exit only after the plan is valid, specific, and ready for approval and execution handoff.

Plan requirements:
- The plan must include goal, files, assumptions, openQuestions, items, verification, risks, and status.
- Each item needs a stable id, concrete title, explicit outcome, explicit validation, and dependencies when relevant.
- Prefer executionMode: single. swarm is not supported in absolute-plan v2 yet.
- Include verification steps that mention tests or checks.
- Keep the plan concise but implementation-ready. Avoid vague steps.

${goal}
${planFilePath}
`.trim();
}
