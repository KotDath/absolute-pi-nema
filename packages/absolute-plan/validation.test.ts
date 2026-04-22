import { describe, expect, it } from "vitest";
import { normalizePlanDoc, validatePlanDoc } from "./validation.js";

describe("absolute-plan validation", () => {
	it("accepts a concrete ready plan", () => {
		const plan = normalizePlanDoc({
			goal: "Implement planning mode",
			assumptions: ["absolute-qwen tools stay available"],
			openQuestions: [],
			files: ["packages/absolute-plan/index.ts"],
			items: [
				{
					id: "plan-runtime",
					title: "Build planning runtime",
					outcome: "Planning mode can enter and persist state.",
					validation: "Run runtime tests for command, shortcut, and state restore.",
				},
			],
			verification: ["Run vitest for absolute-plan package."],
			risks: [{ risk: "Prompt drift", mitigation: "Validate with smoke tests." }],
			status: "ready",
		});

		expect(validatePlanDoc(plan)).toEqual({
			valid: true,
			errors: [],
			warnings: expect.any(Array),
		});
	});

	it("rejects dependency cycles and missing verification", () => {
		const plan = normalizePlanDoc({
			goal: "Broken plan",
			assumptions: [],
			openQuestions: [],
			files: [],
			items: [
				{
					id: "a",
					title: "Inspect",
					outcome: "Inspect code",
					validation: "Check it",
					dependsOn: ["b"],
				},
				{
					id: "b",
					title: "Implement",
					outcome: "Implement code",
					validation: "Verify it",
					dependsOn: ["a"],
				},
			],
			verification: [],
			risks: [],
			status: "draft",
		});

		const result = validatePlanDoc(plan);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Plan must include at least one verification step.");
		expect(result.errors.some((error: string) => error.includes("cycle"))).toBe(true);
		expect(result.errors).toContain("Plan must include at least one file or scope anchor.");
	});
});
