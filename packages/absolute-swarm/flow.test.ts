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
		});

		const finished = await runtime.runCell(cell.id);
		expect(finished.status).toBe("blocked");
		expect(finished.result?.status).toBe("needs_review");
		expect(finished.result?.blockers).toContain("Missing integration-level proof.");
	});
});
