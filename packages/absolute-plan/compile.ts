import type { PlanDoc, PlanItem, TaskComplexity, TaskGraph } from "./types.js";
import { validatePlanDoc } from "./validation.js";

const COMPLEXITY_KEYWORD_PATTERN = /\b(refactor|architecture|protocol|workflow|runtime|coordinat|migrate|cross-cutting|orchestrat|state machine|multi-agent)\b/i;

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function scorePlanItem(plan: PlanDoc, item: PlanItem): TaskComplexity {
	const writeScope = item.files.length > 0 ? item.files : plan.files;
	let score = 0;
	const reasons: string[] = [];

	if (writeScope.length >= 2) {
		score += 2;
		reasons.push(`touches ${writeScope.length} scoped files`);
	}
	if (item.dependsOn.length > 0) {
		score += 1 + item.dependsOn.length;
		reasons.push(`has ${item.dependsOn.length} dependencies`);
	}
	if (item.risk === "medium") {
		score += 2;
		reasons.push("marked medium risk");
	}
	if (item.risk === "high") {
		score += 4;
		reasons.push("marked high risk");
	}
	if (item.hydrate) {
		score += 3;
		reasons.push("requires hydrate/discovery");
	}
	if (item.assumptions.length > 0) {
		score += 1;
		reasons.push(`carries ${item.assumptions.length} task assumptions`);
	}
	if (item.outcome.length > 120) {
		score += 1;
		reasons.push("broad outcome description");
	}
	if (item.validation.length > 100) {
		score += 1;
		reasons.push("non-trivial validation");
	}
	if (COMPLEXITY_KEYWORD_PATTERN.test(`${item.title} ${item.outcome} ${item.validation}`)) {
		score += 2;
		reasons.push("architecture/runtime-heavy wording");
	}

	const level = score <= 2 ? "low" : score <= 5 ? "medium" : "high";
	return {
		level,
		score,
		reasoning: reasons.length > 0 ? reasons.join("; ") : "local scoped task with straightforward validation",
	};
}

function resolveExecutionMode(item: PlanItem, complexity: TaskComplexity): "single" | "swarm" {
	if (item.executionMode === "single") {
		return "single";
	}
	if (complexity.level === "low") {
		return "single";
	}
	return "swarm";
}

export function compilePlanDoc(plan: PlanDoc): TaskGraph {
	const validation = validatePlanDoc(plan);
	if (!validation.valid) {
		throw new Error(validation.errors.join(" "));
	}

	return {
		id: `graph-${Date.now().toString(36)}`,
		goal: plan.goal,
		verification: [...plan.verification],
		tasks: plan.items.map((item) => {
			const writeScope = uniqueStrings(item.files.length > 0 ? [...item.files] : [...plan.files]);
			const complexity = scorePlanItem(plan, item);
			return {
				id: item.id,
				title: item.title,
				spec: item.outcome,
				status: "pending" as const,
				dependsOn: [...item.dependsOn],
				writeScope,
				validation: [item.validation],
				executionMode: resolveExecutionMode(item, complexity),
				owner: undefined,
				artifacts: [],
				changedFiles: [],
				blockers: [],
				notes: [],
				resultSummary: undefined,
				risk: item.risk,
				hydrate: item.hydrate,
				followUpOf: undefined,
				complexity,
			};
		}),
	};
}
