import { describe, expect, it } from "vitest";
import { applyTaskResult, findReadyTasks, formatTaskList, getExecutionStatus, hasWriteConflict } from "./executor.js";
import { compilePlanDoc } from "./compile.js";
import { normalizePlanDoc } from "./validation.js";

function createGraph() {
	return compilePlanDoc(
		normalizePlanDoc({
			goal: "Implement executor",
			assumptions: [],
			openQuestions: [],
			files: ["packages/absolute-plan/index.ts"],
			items: [
				{
					id: "task-a",
					title: "Implement first task",
					outcome: "First task is implemented.",
					validation: "Run unit tests.",
				},
				{
					id: "task-b",
					title: "Implement second task",
					outcome: "Second task is implemented.",
					validation: "Run integration tests.",
					dependsOn: ["task-a"],
				},
			],
			verification: ["Run final verification."],
			risks: [],
			status: "ready",
		}),
	);
}

describe("absolute-plan executor helpers", () => {
	it("finds ready tasks and write conflicts", () => {
		const graph = createGraph();
		expect(findReadyTasks(graph).map((task) => task.id)).toEqual(["task-a"]);

		const conflictingGraph = {
			...graph,
			tasks: graph.tasks.map((task) =>
				task.id === "task-a" ? { ...task, status: "in_progress" as const } : task,
			),
		};
		expect(hasWriteConflict(conflictingGraph.tasks[1], conflictingGraph)).toBe(true);
	});

	it("creates a follow-up task for needs_review and unblocks parents when follow-up completes", () => {
		const graph = createGraph();
		const firstPass = applyTaskResult(graph, {
			taskId: "task-a",
			status: "needs_review",
			summary: "Implementation needs review.",
			changedFiles: ["packages/absolute-plan/index.ts"],
			validationsRun: ["Ran unit tests."],
			artifacts: [],
			blockers: ["Review required."],
			notes: ["Check edge cases."],
		});

		expect(firstPass.followUpTaskId).toBe("task-a--review-1");
		expect(firstPass.graph.tasks.find((task) => task.id === "task-a")?.status).toBe("blocked");
		expect(firstPass.graph.tasks.find((task) => task.id === "task-a--review-1")?.followUpOf).toBe("task-a");
		expect(firstPass.graph.tasks.find((task) => task.id === "task-a--review-1")?.executionMode).toBe("swarm");
		expect(getExecutionStatus(firstPass.graph, "pending")).toBe("pending");

		const secondPass = applyTaskResult(firstPass.graph, {
			taskId: "task-a--review-1",
			status: "completed",
			summary: "Review completed.",
			changedFiles: [],
			validationsRun: ["Reviewed implementation."],
			artifacts: [],
			notes: [],
		});

		expect(secondPass.graph.tasks.find((task) => task.id === "task-a")?.status).toBe("pending");
		expect(formatTaskList(secondPass.graph)).toContain("task-a [pending]");
	});

	it("reports verification readiness only after all tasks are completed", () => {
		const graph = createGraph();
		expect(getExecutionStatus(graph, "pending")).toBe("pending");

		const completedGraph = {
			...graph,
			tasks: graph.tasks.map((task) => ({ ...task, status: "completed" as const })),
		};
		expect(getExecutionStatus(completedGraph, "pending")).toBe("ready_for_verification");
		expect(getExecutionStatus(completedGraph, "passed")).toBe("completed");
	});
});
