import { describe, expect, it } from "vitest";
import { createSwarmRuntime } from "./index.js";
import type { RoleRunner } from "./types.js";

function createFakeRunner(): RoleRunner {
	let nextRun = 1;
	const results = new Map<string, string>();
	return {
		async startRole(role) {
			const runId = `run-${nextRun++}`;
			if (role === "implementer") {
				if (nextRun === 2) {
					results.set(
						runId,
						JSON.stringify({
							summary: "Initial approach ready.",
							verdict: "continue",
							entries: [{ type: "proposal", content: "Apply focused changes." }],
							messages: [{ to: "critic", kind: "request", content: "Stress the approach." }],
						}),
					);
				} else {
					results.set(
						runId,
						JSON.stringify({
							summary: "Implemented the task.",
							verdict: "completed",
							entries: [{ type: "evidence", content: "Implementation complete." }],
							taskResult: {
								taskId: "task-a",
								status: "completed",
								summary: "Task implemented.",
								changedFiles: ["index.ts"],
								validationsRun: ["unit test"],
								artifacts: [],
								blockers: [],
								notes: [],
							},
						}),
					);
				}
			}
			if (role === "critic") {
				results.set(
					runId,
					JSON.stringify({
						summary: "Risk surfaced but manageable.",
						verdict: "continue",
						entries: [{ type: "question", content: "Confirm edge cases." }],
						messages: [{ to: "implementer", kind: "reply", content: "Cover edge cases in execution." }],
					}),
				);
			}
			if (role === "verifier") {
				results.set(
					runId,
					JSON.stringify({
						summary: "Verification passed.",
						verdict: "completed",
						entries: [{ type: "evidence", content: "Validation passed." }],
						validationsRun: ["integration test"],
					}),
				);
			}
			return { runId };
		},
		async waitForRun(runId) {
			return {
				status: "completed",
				finalText: results.get(runId) ?? "",
			};
		},
		async stopRun() {},
	};
}

describe("absolute-swarm runtime", () => {
	it("creates and executes a task cell", async () => {
		const runtime = createSwarmRuntime({ roleRunner: createFakeRunner() });
		const cell = runtime.createCell({
			id: "task-a",
			title: "Implement feature",
			spec: "Implement the feature safely.",
			writeScope: ["index.ts"],
			validation: ["Run tests."],
			hydrate: false,
			complexity: { level: "high", score: 7, reasoning: "cross-cutting task" },
			taskBrief: {
				planGoal: "Ship the feature",
				taskPurpose: "Implement the feature task",
				upstreamContext: ["No upstream tasks."],
				downstreamConstraints: ["No downstream constraints."],
				definitionOfDone: ["Run tests."],
				verificationContext: ["Verify the feature."],
			},
		});

		const completed = await runtime.runCell(cell.id);
		expect(completed.status).toBe("completed");
		expect(completed.result?.status).toBe("completed");
		expect(completed.result?.validationsRun).toEqual(["unit test", "integration test"]);
		expect(completed.blackboard.length).toBeGreaterThan(0);
		expect(completed.mailbox.length).toBeGreaterThan(0);
		expect(runtime.collectCellResult(cell.id)?.summary).toBe("Verification passed.");
	});
});
