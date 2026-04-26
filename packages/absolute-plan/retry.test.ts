import { describe, expect, it } from "vitest";
import { compilePlanDoc } from "./compile.js";
import { buildFailureSummary, buildTaskBrief, canRetryTask, createDefaultRetryState, formatFailureSummary, formatTaskBrief } from "./retry.js";
import type { TaskNode, TaskResult } from "./types.js";
import { normalizePlanDoc } from "./validation.js";

function createGraph() {
	return compilePlanDoc(
		normalizePlanDoc({
			goal: "Implement retry flow",
			assumptions: [],
			openQuestions: [],
			files: ["packages/absolute-plan/index.ts"],
			items: [
				{
					id: "task-a",
					title: "Implement task A",
					outcome: "Task A is implemented.",
					validation: "Run task checks.",
				},
				{
					id: "task-b",
					title: "Implement task B",
					outcome: "Task B is implemented after task A.",
					validation: "Run downstream checks.",
					dependsOn: ["task-a"],
				},
			],
			verification: ["Run final verification."],
			risks: [],
			status: "ready",
		}),
	);
}

describe("absolute-plan retry helpers", () => {
	it("builds task briefs with upstream and downstream context", () => {
		const graph = createGraph();
		const task = graph.tasks.find((candidate) => candidate.id === "task-a") as TaskNode;
		const brief = buildTaskBrief(graph, task);

		expect(brief.planGoal).toBe("Implement retry flow");
		expect(brief.upstreamContext).toEqual(["No upstream tasks."]);
		expect(brief.downstreamConstraints).toEqual(["task-b: Implement task B"]);
		expect(formatTaskBrief(brief)).toContain("Definition of done: Run task checks.");
	});

	it("allows one retry for failed or blocked outcomes and formats failure summaries", () => {
		const retry = createDefaultRetryState();
		const task = {
			...createGraph().tasks[0],
			retry: {
				...retry,
				attempt: 1,
			},
		};
		const result: TaskResult = {
			taskId: task.id,
			status: "blocked",
			summary: "Missing expected file trace.",
			changedFiles: ["packages/absolute-plan/index.ts"],
			validationsRun: ["Ran task checks."],
			artifacts: [],
			blockers: ["Need a cleaner diff."],
			notes: ["Retry in isolated workspace."],
		};

		expect(canRetryTask(task, result)).toBe(true);
		const failureSummary = buildFailureSummary(task, result, {
			worktreePath: "/tmp/retry-worktree",
			baseRef: "abc123",
		});
		expect(failureSummary.attempt).toBe(1);
		expect(failureSummary.kind).toBe("blocked");
		expect(formatFailureSummary(failureSummary)).toContain("Failure kind: blocked");
		expect(formatFailureSummary(failureSummary)).toContain("Changed files: packages/absolute-plan/index.ts");
	});

	it("does not auto-retry needs_review outcomes", () => {
		const task = createGraph().tasks[0];
		const result: TaskResult = {
			taskId: task.id,
			status: "needs_review",
			summary: "Needs human review.",
			changedFiles: [],
			validationsRun: [],
			artifacts: [],
			blockers: ["Quality gate not met."],
			notes: [],
		};

		expect(canRetryTask(task, result)).toBe(false);
	});
});
