import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../absolute-subagents/types.js";
import absolutePlanExtension from "./index.js";
import { createExtensionHarness } from "./test-harness.js";

const tempDirs: string[] = [];

async function createTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absolute-plan-"));
	tempDirs.push(dir);
	return dir;
}

function createAgentResult(runId: string, taskId: string, status: "completed" | "blocked" | "failed" | "needs_review" = "completed"): AgentResult {
	return {
		id: runId,
		agent: taskId === "__verification__" ? "verifier" : "worker",
		mode: "background",
		status: "completed",
		sessionDir: `/tmp/${runId}`,
		turns: [],
		finalText: JSON.stringify({
			taskId,
			status,
			summary: `${taskId} ${status}`,
			changedFiles: taskId === "__verification__" ? [] : ["packages/absolute-plan/index.ts"],
			validationsRun: taskId === "__verification__" ? ["Ran final verification."] : ["Ran task checks."],
			artifacts: [],
			blockers: [],
			notes: [],
		}),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	};
}

function createFakeWorkerRuntime() {
	const results = new Map<string, AgentResult>();
	let counter = 0;
	return {
		async startTask(_ctx: any, task: { id: string }) {
			counter += 1;
			const runId = `run-${counter}`;
			results.set(runId, createAgentResult(runId, task.id));
			return { runId };
		},
		async startVerification() {
			counter += 1;
			const runId = `run-${counter}`;
			results.set(runId, createAgentResult(runId, "__verification__"));
			return { runId };
		},
		async waitForRun(_ctx: any, runId: string) {
			return {
				state: { status: "completed" },
				result: results.get(runId) ?? null,
			};
		},
		async stopRun() {},
	};
}

function getLatestPlanState(harness: ReturnType<typeof createExtensionHarness>) {
	const latest = [...harness.entries]
		.reverse()
		.find((entry) => entry.customType === "absolute-plan:state");
	return latest?.data;
}

async function waitForCondition(condition: () => boolean, timeoutMs = 200) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition was not met before timeout.");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("absolute-plan flow", () => {
	it("runs the happy path from /plan through approval, execution, and verification", async () => {
		const tempDir = await createTempDir();
		const harness = createExtensionHarness({ cwd: tempDir });
		harness.ctx.ui.select = async () => "Approve and compile";
		absolutePlanExtension(harness.pi, { workerRuntime: createFakeWorkerRuntime() as any });

		await harness.commands.get("plan").handler("", harness.ctx);
		const planFilePath = getLatestPlanState(harness)?.planFilePath as string;
		expect(await fs.readFile(planFilePath, "utf8")).toContain("Planning Draft");

		const valid = await harness.tools.get("set_plan").execute(
			"tool-2",
			{
				plan: {
					goal: "Implement planning mode",
					assumptions: ["absolute-qwen remains the source of built-in tools"],
					openQuestions: [],
					files: ["packages/absolute-plan/index.ts"],
					items: [
						{
							id: "runtime",
							title: "Implement planning runtime",
							outcome: "Planning mode toggles, persists state, blocks mutations, and runs execution mode.",
							validation: "Run runtime and flow tests.",
						},
					],
					verification: ["Run vitest for packages/absolute-plan."],
					risks: [{ risk: "API drift", mitigation: "Keep tests around session hooks." }],
					status: "ready",
				},
			},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(valid.isError).not.toBe(true);
		expect(await fs.readFile(planFilePath, "utf8")).toContain("Implement planning runtime");

		const exitResult = await harness.tools.get("plan_exit").execute("tool-3", {}, undefined, undefined, harness.ctx);
		expect(exitResult.content).toEqual([{ type: "text", text: "Plan approved. Execution mode started." }]);

		await waitForCondition(() => getLatestPlanState(harness)?.status === "completed");
		const finalState = getLatestPlanState(harness);
		expect(finalState.mode).toBe("execution");
		expect(finalState.status).toBe("completed");
		expect(finalState.execution.verificationStatus).toBe("passed");
		expect(finalState.compiledTaskGraph.tasks[0].status).toBe("completed");
		expect(harness.getActiveTools()).toContain("write");
		expect(harness.getActiveTools()).toContain("get_task_graph");
	});

	it("keeps planning mode active when approval is rejected for revision", async () => {
		const tempDir = await createTempDir();
		const harness = createExtensionHarness({ cwd: tempDir });
		harness.ctx.ui.select = async () => "Keep planning";
		absolutePlanExtension(harness.pi, { workerRuntime: createFakeWorkerRuntime() as any });

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.tools.get("set_plan").execute(
			"tool-1",
			{
				plan: {
					goal: "Implement planning mode",
					assumptions: [],
					openQuestions: [],
					files: ["packages/absolute-plan/index.ts"],
					items: [
						{
							id: "runtime",
							title: "Implement planning runtime",
							outcome: "Planning mode toggles.",
							validation: "Run tests.",
						},
					],
					verification: ["Run tests."],
					risks: [],
					status: "ready",
				},
			},
			undefined,
			undefined,
			harness.ctx,
		);

		const exitResult = await harness.tools.get("plan_exit").execute("tool-2", {}, undefined, undefined, harness.ctx);
		expect(exitResult.content).toEqual([{ type: "text", text: "Plan kept in planning mode for revision." }]);
		expect(getLatestPlanState(harness)?.mode).toBe("planning");
		expect(harness.getActiveTools()).toContain("set_plan");
	});
});
