import type { FailureSummary, RetryFailureKind, TaskBrief, TaskGraph, TaskNode, TaskResult } from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 2;

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function createDefaultRetryState() {
	return {
		attempt: 0,
		maxAttempts: DEFAULT_MAX_ATTEMPTS,
		status: "idle" as const,
	};
}

export function getTaskRetryState(task: TaskNode) {
	return {
		attempt: task.retry?.attempt ?? 0,
		maxAttempts: task.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		status: task.retry?.status ?? ("idle" as const),
		lastFailureKind: task.retry?.lastFailureKind,
		lastFailureSummary: task.retry?.lastFailureSummary,
		lastAttemptBaseRef: task.retry?.lastAttemptBaseRef,
		lastAttemptWorktreePath: task.retry?.lastAttemptWorktreePath,
	};
}

export function isRetriableTaskResult(result: TaskResult): result is TaskResult & { status: "failed" | "blocked" } {
	return result.status === "failed" || result.status === "blocked";
}

export function canRetryTask(task: TaskNode, result: TaskResult): boolean {
	if (!isRetriableTaskResult(result)) {
		return false;
	}
	const retry = getTaskRetryState(task);
	return retry.attempt < retry.maxAttempts;
}

export function buildTaskBrief(graph: TaskGraph, task: TaskNode): TaskBrief {
	const upstreamContext = graph.tasks
		.filter((candidate) => task.dependsOn.includes(candidate.id))
		.map((candidate) => `${candidate.id}: ${candidate.title}${candidate.resultSummary ? ` (${candidate.resultSummary})` : ""}`);
	const downstreamConstraints = graph.tasks
		.filter((candidate) => candidate.dependsOn.includes(task.id))
		.map((candidate) => `${candidate.id}: ${candidate.title}`);
	return {
		planGoal: graph.goal,
		taskPurpose: `${task.title}: ${task.spec}`,
		upstreamContext: upstreamContext.length > 0 ? upstreamContext : ["No upstream tasks."],
		downstreamConstraints: downstreamConstraints.length > 0 ? downstreamConstraints : ["No downstream task constraints."],
		definitionOfDone: [...task.validation],
		verificationContext: [...graph.verification],
	};
}

export function buildFailureSummary(task: TaskNode, result: TaskResult, options?: { worktreePath?: string; baseRef?: string }): FailureSummary {
	const kind: RetryFailureKind = result.status === "failed" ? "failed" : "blocked";
	const retry = getTaskRetryState(task);
	return {
		attempt: retry.attempt,
		kind,
		summary: result.summary,
		blockers: uniqueStrings(result.blockers ?? []),
		validationsRun: uniqueStrings(result.validationsRun),
		changedFiles: uniqueStrings(result.changedFiles),
		notes: uniqueStrings(result.notes ?? []),
		worktreePath: options?.worktreePath,
		baseRef: options?.baseRef,
	};
}

export function formatTaskBrief(taskBrief: TaskBrief): string {
	return [
		`Plan goal: ${taskBrief.planGoal}`,
		`Task purpose: ${taskBrief.taskPurpose}`,
		`Upstream context: ${taskBrief.upstreamContext.join(" | ")}`,
		`Downstream constraints: ${taskBrief.downstreamConstraints.join(" | ")}`,
		`Definition of done: ${taskBrief.definitionOfDone.join(" | ")}`,
		`Verification context: ${taskBrief.verificationContext.join(" | ")}`,
	].join("\n");
}

export function formatFailureSummary(failureSummary: FailureSummary | undefined): string {
	if (!failureSummary) {
		return "No previous failure summary.";
	}
	return [
		`Previous attempt: ${failureSummary.attempt}`,
		`Failure kind: ${failureSummary.kind}`,
		`Summary: ${failureSummary.summary}`,
		`Blockers: ${failureSummary.blockers.join(" | ") || "none"}`,
		`Validations already run: ${failureSummary.validationsRun.join(" | ") || "none"}`,
		`Changed files: ${failureSummary.changedFiles.join(", ") || "none"}`,
		`Notes: ${failureSummary.notes.join(" | ") || "none"}`,
	].join("\n");
}
