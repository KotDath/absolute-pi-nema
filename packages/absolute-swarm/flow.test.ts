import { describe, expect, it } from "vitest";
import { createSwarmRuntime } from "./index.js";
import type { RoleRunner } from "./types.js";

describe("absolute-swarm flow", () => {
	it("blocks the cell when verifier rejects the result", async () => {
		let step = 0;
		const results = new Map<string, string>();
		const runner: RoleRunner = {
			async startRole(role) {
				step += 1;
				const runId = `run-${step}`;
				if (role === "implementer" && step === 1) {
					results.set(runId, JSON.stringify({ summary: "Initial plan", verdict: "continue", entries: [], messages: [] }));
				} else if (role === "critic") {
					results.set(runId, JSON.stringify({ summary: "Needs closer review", verdict: "continue", entries: [], messages: [] }));
				} else if (role === "implementer") {
					results.set(
						runId,
						JSON.stringify({
							summary: "Implemented but not fully proven",
							verdict: "completed",
							entries: [],
							messages: [],
							taskResult: {
								taskId: "task-b",
								status: "completed",
								summary: "Implementation done",
								changedFiles: ["task.ts"],
								validationsRun: ["unit"],
								artifacts: [],
								blockers: [],
								notes: [],
							},
						}),
					);
				} else {
					results.set(
						runId,
						JSON.stringify({
							summary: "Verification evidence is insufficient.",
							verdict: "needs_review",
							entries: [{ type: "blocker", content: "Need stronger verification." }],
							messages: [{ to: "implementer", kind: "escalation", content: "Add stronger tests." }],
							validationsRun: ["reviewed task result"],
							notes: ["Missing integration-level proof."],
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

		const runtime = createSwarmRuntime({ roleRunner: runner });
		const cell = runtime.createCell({
			id: "task-b",
			title: "Hard task",
			spec: "Perform a hard task.",
			writeScope: ["task.ts", "task.test.ts"],
			validation: ["Run hard verification."],
			hydrate: false,
			complexity: { level: "high", score: 6, reasoning: "multiple files and verification burden" },
			taskBrief: {
				planGoal: "Finish the hard task",
				taskPurpose: "Deliver the hard task safely",
				upstreamContext: ["No upstream tasks."],
				downstreamConstraints: ["No downstream constraints."],
				definitionOfDone: ["Run hard verification."],
				verificationContext: ["Hard verification is mandatory."],
			},
		});

		const finished = await runtime.runCell(cell.id);
		expect(finished.status).toBe("blocked");
		expect(finished.result?.status).toBe("needs_review");
		expect(finished.result?.blockers).toContain("Missing integration-level proof.");
	});

	it("converts lifecycle exceptions into failed cell results", async () => {
		const runner: RoleRunner = {
			async startRole(role) {
				if (role === "critic") {
					throw new Error("critic runner exploded");
				}
				return { runId: `run-${role}` };
			},
			async waitForRun() {
				return {
					status: "completed",
					finalText: JSON.stringify({
						summary: "Initial plan complete",
						verdict: "continue",
						entries: [],
						messages: [],
					}),
				};
			},
			async stopRun() {},
		};

		const runtime = createSwarmRuntime({ roleRunner: runner });
		const cell = runtime.createCell({
			id: "task-c",
			title: "Exceptional task",
			spec: "Trigger an internal lifecycle exception.",
			writeScope: ["task.ts"],
			validation: ["Return a terminal result."],
			hydrate: false,
			complexity: { level: "medium", score: 4, reasoning: "exercise error conversion" },
			taskBrief: {
				planGoal: "Exercise error conversion",
				taskPurpose: "Ensure runtime does not hang on thrown exceptions",
				upstreamContext: ["No upstream tasks."],
				downstreamConstraints: ["No downstream constraints."],
				definitionOfDone: ["Return a terminal result."],
				verificationContext: ["Runtime must surface thrown errors as failed cells."],
			},
		});

		const finished = await runtime.runCell(cell.id);
		expect(finished.status).toBe("failed");
		expect(finished.result?.status).toBe("failed");
		expect(finished.result?.summary).toContain("critic runner exploded");
	});
});
