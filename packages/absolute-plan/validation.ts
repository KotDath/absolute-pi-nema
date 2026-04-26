import type { PlanDoc, PlanItem, PlanItemRisk, PlanItemStatus, TaskResult, UserInputQuestion, ValidationResult } from "./types.js";

const PLAN_ITEM_STATUSES = new Set<PlanItemStatus>(["pending", "in_progress", "completed", "blocked"]);
const EXECUTION_MODES = new Set(["single", "swarm"]);
const VAGUE_TEXT_PATTERN =
	/^(do|make|fix|change|update|handle|work on|implement)(\s+(the|this|that))?\s*(code|stuff|things|it)?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const items = value
		.map((entry) => normalizeString(entry))
		.filter((entry) => entry.length > 0);
	return Array.from(new Set(items));
}

function normalizePlanItem(value: unknown): PlanItem {
	const item = isRecord(value) ? value : {};
	const statusValue = normalizeString(item.status);
	const executionModeValue = normalizeString(item.executionMode);
	const riskValue = normalizeString(item.risk);

	return {
		id: normalizeString(item.id),
		title: normalizeString(item.title),
		status: PLAN_ITEM_STATUSES.has(statusValue as PlanItemStatus) ? (statusValue as PlanItemStatus) : "pending",
		outcome: normalizeString(item.outcome),
		validation: normalizeString(item.validation),
		dependsOn: normalizeStringArray(item.dependsOn),
		files: normalizeStringArray(item.files),
		assumptions: normalizeStringArray(item.assumptions),
		risk: riskValue === "low" || riskValue === "medium" || riskValue === "high" ? (riskValue as PlanItemRisk) : undefined,
		hydrate: Boolean(item.hydrate),
		executionMode: EXECUTION_MODES.has(executionModeValue) ? (executionModeValue as "single" | "swarm") : "swarm",
	};
}

export function normalizePlanDoc(value: unknown): PlanDoc {
	const doc = isRecord(value) ? value : {};
	const statusValue = normalizeString(doc.status);
	return {
		version: 1,
		goal: normalizeString(doc.goal),
		assumptions: normalizeStringArray(doc.assumptions),
		openQuestions: normalizeStringArray(doc.openQuestions),
		files: normalizeStringArray(doc.files),
		items: Array.isArray(doc.items) ? doc.items.map((item) => normalizePlanItem(item)) : [],
		verification: normalizeStringArray(doc.verification),
		risks: Array.isArray(doc.risks)
			? doc.risks
					.map((risk) => {
						const record = isRecord(risk) ? risk : {};
						return {
							risk: normalizeString(record.risk),
							mitigation: normalizeString(record.mitigation),
						};
					})
					.filter((risk) => risk.risk && risk.mitigation)
			: [],
		status: statusValue === "ready" ? "ready" : "draft",
	};
}

function findDependencyCycle(items: PlanItem[]): string[] | null {
	const byId = new Map(items.map((item) => [item.id, item] as const));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (itemId: string, trail: string[]): string[] | null => {
		if (visited.has(itemId)) {
			return null;
		}
		if (visiting.has(itemId)) {
			const cycleStart = trail.indexOf(itemId);
			return [...trail.slice(cycleStart), itemId];
		}
		visiting.add(itemId);
		const item = byId.get(itemId);
		for (const dep of item?.dependsOn ?? []) {
			const cycle = visit(dep, [...trail, itemId]);
			if (cycle) {
				return cycle;
			}
		}
		visiting.delete(itemId);
		visited.add(itemId);
		return null;
	};

	for (const item of items) {
		const cycle = visit(item.id, []);
		if (cycle) {
			return cycle;
		}
	}
	return null;
}

function isVagueText(value: string): boolean {
	const compact = value.replace(/\s+/g, " ").trim();
	if (!compact) {
		return true;
	}
	return compact.length < 8 || VAGUE_TEXT_PATTERN.test(compact);
}

function hasAnyFileAnchor(plan: PlanDoc): boolean {
	if (plan.files.length > 0) {
		return true;
	}
	return plan.items.some((item) => item.files.length > 0);
}

export function validatePlanDoc(plan: PlanDoc): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!plan.goal) {
		errors.push("Plan goal is required.");
	}
	if (plan.items.length === 0) {
		errors.push("Plan must contain at least one item.");
	}
	if (plan.verification.length === 0) {
		errors.push("Plan must include at least one verification step.");
	}
	if (plan.status === "ready" && plan.openQuestions.length > 0) {
		errors.push("Ready plans cannot keep unresolved open questions.");
	}

	const ids = new Set<string>();
	let inProgressCount = 0;
	for (const item of plan.items) {
		if (!item.id) {
			errors.push("Every plan item must have an id.");
		} else if (ids.has(item.id)) {
			errors.push(`Duplicate plan item id: ${item.id}.`);
		} else {
			ids.add(item.id);
		}
		if (!item.title) {
			errors.push(`Plan item ${item.id || "(missing id)"} must have a title.`);
		}
		if (!item.outcome) {
			errors.push(`Plan item ${item.id || item.title || "(missing id)"} must define an outcome.`);
		}
		if (!item.validation) {
			errors.push(`Plan item ${item.id || item.title || "(missing id)"} must define validation.`);
		}
		if (item.status === "in_progress") {
			inProgressCount += 1;
		}
		if (isVagueText(item.title)) {
			warnings.push(`Plan item ${item.id || "(missing id)"} title is too vague.`);
		}
		if (isVagueText(item.outcome)) {
			warnings.push(`Plan item ${item.id || "(missing id)"} outcome is too vague.`);
		}
		if (isVagueText(item.validation)) {
			warnings.push(`Plan item ${item.id || "(missing id)"} validation is too vague.`);
		}
		if (item.hydrate && item.status === "completed") {
			warnings.push(`Plan item ${item.id || "(missing id)"} is marked hydrate but already completed.`);
		}
		if (plan.files.length > 1 && item.files.length === 0) {
			warnings.push(`Plan item ${item.id || "(missing id)"} does not declare item.files and may be too broad.`);
		}
	}

	if (inProgressCount > 1) {
		errors.push("At most one plan item can be in progress.");
	}

	for (const item of plan.items) {
		for (const dependencyId of item.dependsOn) {
			if (!ids.has(dependencyId)) {
				errors.push(`Plan item ${item.id} depends on unknown item: ${dependencyId}.`);
			}
		}
	}

	const cycle = findDependencyCycle(plan.items);
	if (cycle) {
		errors.push(`Plan dependencies contain a cycle: ${cycle.join(" -> ")}.`);
	}

	if (plan.items.length > 12) {
		warnings.push("Plan is heavily fragmented; merge micro-steps where possible.");
	}
	if (plan.items.length === 1) {
		warnings.push("Single-step plans are usually too coarse for non-trivial implementation work.");
	}
	if (!hasAnyFileAnchor(plan) && plan.items.length > 1) {
		errors.push("Plan must include at least one file or scope anchor.");
	}
	if (!plan.verification.some((entry) => /test|verify|assert|check/i.test(entry))) {
		warnings.push("Verification section does not mention tests or checks explicitly.");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

export function normalizeUserInputQuestions(value: unknown): UserInputQuestion[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((question) => {
			const record = isRecord(question) ? question : {};
			const kind: "input" | "select" = normalizeString(record.kind) === "input" ? "input" : "select";
			return {
				id: normalizeString(record.id),
				label: normalizeString(record.label) || normalizeString(record.id),
				question: normalizeString(record.question),
				kind,
				options: normalizeStringArray(record.options),
				placeholder: normalizeString(record.placeholder) || undefined,
			};
		})
		.filter((question) => question.id && question.label && question.question);
}

export function normalizeTaskResult(value: unknown): TaskResult {
	const record = isRecord(value) ? value : {};
	const statusValue = normalizeString(record.status);
	return {
		taskId: normalizeString(record.taskId),
		status:
			statusValue === "completed" || statusValue === "blocked" || statusValue === "failed" || statusValue === "needs_review"
				? statusValue
				: "failed",
		summary: normalizeString(record.summary),
		changedFiles: normalizeStringArray(record.changedFiles),
		validationsRun: normalizeStringArray(record.validationsRun),
		artifacts: normalizeStringArray(record.artifacts),
		blockers: normalizeStringArray(record.blockers),
		notes: normalizeStringArray(record.notes),
	};
}
