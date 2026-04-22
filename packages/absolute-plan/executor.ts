import type {
	ExecutionHistoryEntry,
	ExecutionState,
	TaskGraph,
	TaskNode,
	TaskResult,
	TaskStatus,
	VerificationStatus,
} from "./types.js";

function cloneTask(task: TaskNode): TaskNode {
	return {
		...task,
		dependsOn: [...task.dependsOn],
		writeScope: [...task.writeScope],
		validation: [...task.validation],
		artifacts: [...task.artifacts],
		changedFiles: [...task.changedFiles],
		blockers: [...task.blockers],
		notes: [...task.notes],
	};
}

function updateTask(graph: TaskGraph, taskId: string, updater: (task: TaskNode) => TaskNode): TaskGraph {
	return {
		...graph,
		tasks: graph.tasks.map((task) => (task.id === taskId ? updater(cloneTask(task)) : cloneTask(task))),
	};
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function isCompleted(task: TaskNode): boolean {
	return task.status === "completed";
}

export function summarizeTaskGraph(graph: TaskGraph): string {
	const totals = graph.tasks.reduce(
		(acc, task) => {
			acc.total += 1;
			acc[task.status] += 1;
			return acc;
		},
		{
			total: 0,
			pending: 0,
			claimed: 0,
			in_progress: 0,
			blocked: 0,
			completed: 0,
			failed: 0,
		},
	);
	return [
		`Goal: ${graph.goal}`,
		`Tasks: ${totals.total}`,
		`Completed: ${totals.completed}`,
		`In progress: ${totals.in_progress}`,
		`Claimed: ${totals.claimed}`,
		`Pending: ${totals.pending}`,
		`Blocked: ${totals.blocked}`,
		`Failed: ${totals.failed}`,
	].join("\n");
}

export function formatTaskList(graph: TaskGraph): string {
	if (graph.tasks.length === 0) {
		return "No tasks compiled.";
	}
	return graph.tasks
		.map((task) => {
			const deps = task.dependsOn.length > 0 ? ` deps=${task.dependsOn.join(",")}` : "";
			const owner = task.owner ? ` owner=${task.owner}` : "";
			const followUp = task.followUpOf ? ` followUpOf=${task.followUpOf}` : "";
			return `- ${task.id} [${task.status}] mode=${task.executionMode} complexity=${task.complexity.level}/${task.complexity.score}${deps}${owner}${followUp} :: ${task.title}`;
		})
		.join("\n");
}

export function findReadyTasks(graph: TaskGraph): TaskNode[] {
	const tasksById = new Map(graph.tasks.map((task) => [task.id, task] as const));
	return graph.tasks.filter((task) => {
		if (task.status !== "pending") {
			return false;
		}
		if (task.owner) {
			return false;
		}
		return task.dependsOn.every((dependencyId) => tasksById.get(dependencyId)?.status === "completed");
	});
}

export function hasWriteConflict(task: TaskNode, graph: TaskGraph): boolean {
	const busyScopes = new Set(
		graph.tasks
			.filter((candidate) => candidate.status === "claimed" || candidate.status === "in_progress")
			.flatMap((candidate) => candidate.writeScope),
	);
	return task.writeScope.some((scope) => busyScopes.has(scope));
}

export function claimTask(graph: TaskGraph, taskId: string, runId: string): TaskGraph {
	return updateTask(graph, taskId, (task) => ({
		...task,
		status: "claimed",
		owner: runId,
	}));
}

export function startTask(graph: TaskGraph, taskId: string, runId: string): TaskGraph {
	return updateTask(graph, taskId, (task) => ({
		...task,
		status: "in_progress",
		owner: runId,
	}));
}

function createFollowUpId(graph: TaskGraph, taskId: string, suffix: "review" | "blocker"): string {
	const prefix = `${taskId}--${suffix}-`;
	const nextIndex = graph.tasks.filter((task) => task.id.startsWith(prefix)).length + 1;
	return `${prefix}${nextIndex}`;
}

function createFollowUpTask(parent: TaskNode, graph: TaskGraph, result: TaskResult, suffix: "review" | "blocker"): TaskNode {
	const followUpId = createFollowUpId(graph, parent.id, suffix);
	const firstNote = result.notes?.[0] ?? result.summary;
	return {
		id: followUpId,
		title: suffix === "review" ? `Review ${parent.title}` : `Unblock ${parent.title}`,
		spec:
			suffix === "review"
				? `Review and finish task ${parent.id}. Resolve the open quality gate: ${firstNote}`
				: `Investigate and unblock task ${parent.id}. Resolve blocker: ${firstNote}`,
		status: "pending",
		dependsOn: [...parent.dependsOn],
		writeScope: result.changedFiles.length > 0 ? [...result.changedFiles] : [...parent.writeScope],
		validation:
			result.validationsRun.length > 0
				? [...result.validationsRun]
				: [`Produce a concrete unblock or review outcome for task ${parent.id}.`],
		executionMode: "swarm",
		owner: undefined,
		artifacts: [...result.artifacts],
		changedFiles: [...result.changedFiles],
		blockers: [],
		notes: result.notes ? [...result.notes] : [],
		resultSummary: undefined,
		risk: "high",
		hydrate: false,
		followUpOf: parent.id,
		complexity: {
			level: "high",
			score: 7,
			reasoning: `follow-up created from ${parent.id} due to ${suffix}`,
		},
	};
}

function unblockParentIfReady(graph: TaskGraph, task: TaskNode): TaskGraph {
	if (!task.followUpOf || task.status !== "completed") {
		return graph;
	}
	const parent = graph.tasks.find((candidate) => candidate.id === task.followUpOf);
	if (!parent || parent.status !== "blocked") {
		return graph;
	}
	const tasksById = new Map(graph.tasks.map((candidate) => [candidate.id, candidate] as const));
	const canResume = parent.dependsOn.every((dependencyId) => {
		if (dependencyId === task.id) {
			return true;
		}
		return tasksById.get(dependencyId)?.status === "completed";
	});
	if (!canResume) {
		return graph;
	}
	return updateTask(graph, parent.id, (blockedParent) => ({
		...blockedParent,
		status: "pending",
		blockers: [],
		owner: undefined,
		notes: uniqueStrings([...blockedParent.notes, `Follow-up ${task.id} completed.`]),
	}));
}

export function applyTaskResult(graph: TaskGraph, result: TaskResult): { graph: TaskGraph; followUpTaskId?: string } {
	const task = graph.tasks.find((candidate) => candidate.id === result.taskId);
	if (!task) {
		return { graph };
	}

	if (result.status === "completed") {
		const completedGraph = updateTask(graph, task.id, (currentTask) => ({
			...currentTask,
			status: "completed",
			owner: undefined,
			changedFiles: uniqueStrings(result.changedFiles),
			artifacts: uniqueStrings(result.artifacts),
			blockers: [],
			notes: uniqueStrings([...(result.notes ?? []), ...currentTask.notes]),
			resultSummary: result.summary,
		}));
		return { graph: unblockParentIfReady(completedGraph, { ...task, status: "completed", followUpOf: task.followUpOf }) };
	}

	if (result.status === "failed") {
		return {
			graph: updateTask(graph, task.id, (currentTask) => ({
				...currentTask,
				status: "failed",
				owner: undefined,
				changedFiles: uniqueStrings(result.changedFiles),
				artifacts: uniqueStrings(result.artifacts),
				blockers: uniqueStrings(result.blockers ?? [result.summary]),
				notes: uniqueStrings([...(result.notes ?? []), ...currentTask.notes]),
				resultSummary: result.summary,
			})),
		};
	}

	const followUpSuffix = result.status === "needs_review" ? "review" : "blocker";
	const followUpTask = createFollowUpTask(task, graph, result, followUpSuffix);
	const blockedGraph = updateTask(graph, task.id, (currentTask) => ({
		...currentTask,
		status: "blocked",
		owner: undefined,
		dependsOn: uniqueStrings([...currentTask.dependsOn, followUpTask.id]),
		changedFiles: uniqueStrings(result.changedFiles),
		artifacts: uniqueStrings(result.artifacts),
		blockers: uniqueStrings(result.blockers ?? [result.summary]),
		notes: uniqueStrings([...(result.notes ?? []), ...currentTask.notes]),
		resultSummary: result.summary,
	}));
	return {
		graph: {
			...blockedGraph,
			tasks: [...blockedGraph.tasks, followUpTask],
		},
		followUpTaskId: followUpTask.id,
	};
}

export function getExecutionStatus(graph: TaskGraph, verificationStatus: VerificationStatus): TaskStatus | "ready_for_verification" {
	if (graph.tasks.some((task) => task.status === "failed")) {
		return "failed";
	}
	if (graph.tasks.some((task) => task.status === "claimed" || task.status === "in_progress")) {
		return "in_progress";
	}
	if (graph.tasks.some((task) => task.status === "pending")) {
		return "pending";
	}
	if (graph.tasks.some((task) => task.status === "blocked")) {
		return "blocked";
	}
	if (verificationStatus !== "passed") {
		return "ready_for_verification";
	}
	return "completed";
}

export function createHistoryEntry(
	type: ExecutionHistoryEntry["type"],
	message: string,
	options?: { taskId?: string; runId?: string; at?: number },
): ExecutionHistoryEntry {
	return {
		at: options?.at ?? Date.now(),
		type,
		message,
		taskId: options?.taskId,
		runId: options?.runId,
	};
}

export function createInitialExecutionState(): ExecutionState {
	return {
		paused: false,
		runningRunIds: [],
		history: [],
		verificationStatus: "pending",
	};
}
