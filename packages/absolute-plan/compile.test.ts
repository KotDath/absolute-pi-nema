import { describe, expect, it } from "vitest";
import { compilePlanDoc } from "./compile.js";
import { normalizePlanDoc } from "./validation.js";

describe("absolute-plan compile", () => {
	it("compiles plan items into a deterministic task graph", () => {
		const plan = normalizePlanDoc({
			goal: "Implement planning mode",
			assumptions: [],
			openQuestions: [],
			files: ["packages/absolute-plan/index.ts"],
			items: [
				{
					id: "state",
					title: "Persist plan state",
					outcome: "State survives session events.",
					validation: "Add restore tests.",
				},
				{
					id: "compile",
					title: "Compile plan",
					outcome: "Plan compiles to task graph.",
					validation: "Assert compiled graph snapshot.",
					dependsOn: ["state"],
					files: ["packages/absolute-plan/compile.ts"],
					risk: "high",
				},
			],
			verification: ["Run unit tests."],
			risks: [],
			status: "ready",
		});

		expect(compilePlanDoc(plan)).toEqual({
			id: expect.any(String),
			goal: "Implement planning mode",
			verification: ["Run unit tests."],
			tasks: [
				{
					id: "state",
					title: "Persist plan state",
					spec: "State survives session events.",
					status: "pending",
					dependsOn: [],
					writeScope: ["packages/absolute-plan/index.ts"],
					validation: ["Add restore tests."],
					executionMode: "single",
					owner: undefined,
					artifacts: [],
					changedFiles: [],
					blockers: [],
					notes: [],
					resultSummary: undefined,
					risk: undefined,
					hydrate: false,
					followUpOf: undefined,
					complexity: {
						level: "low",
						score: 0,
						reasoning: "local scoped task with straightforward validation",
					},
				},
				{
					id: "compile",
					title: "Compile plan",
					spec: "Plan compiles to task graph.",
					status: "pending",
					dependsOn: ["state"],
					writeScope: ["packages/absolute-plan/compile.ts"],
					validation: ["Assert compiled graph snapshot."],
					executionMode: "swarm",
					owner: undefined,
					artifacts: [],
					changedFiles: [],
					blockers: [],
					notes: [],
					resultSummary: undefined,
					risk: "high",
					hydrate: false,
					followUpOf: undefined,
					complexity: {
						level: "high",
						score: 6,
						reasoning: "has 1 dependencies; marked high risk",
					},
				},
			],
		});
	});
});
