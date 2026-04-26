import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

function runGit(cwd: string, ...args: string[]) {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function initializeGitRepo(cwd: string) {
	runGit(cwd, "init");
	runGit(cwd, "config", "user.name", "Absolute Plan Tests");
	runGit(cwd, "config", "user.email", "absolute-plan@example.com");
	await fs.writeFile(path.join(cwd, "target.txt"), "initial\n", "utf8");
	runGit(cwd, "add", "target.txt");
	runGit(cwd, "commit", "-m", "Initial commit");
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

function createRecoveredWorkerRuntime(scopedPath = "packages/absolute-plan/index.ts") {
	const results = new Map<string, AgentResult>();
	let counter = 0;
	return {
		async startTask(_ctx: any, task: { id: string }) {
			counter += 1;
			const runId = `recovered-run-${counter}`;
			results.set(runId, {
				id: runId,
				agent: "worker",
				mode: "background",
				status: "failed",
				sessionDir: `/tmp/${runId}`,
				turns: [
					{
						messageId: `msg-${runId}`,
						prompt: `Task ${task.id}`,
						exitCode: 1,
						finalText: "",
						startedAt: Date.now(),
						endedAt: Date.now(),
						stopReason: "toolUse",
						error: "Subagent turn timed out after 90000ms.",
						messages: [
							{
								role: "toolResult",
								toolCallId: `write-${runId}`,
								toolName: "write",
								content: [{ type: "text", text: `Created ${scopedPath}` }],
								details: { path: scopedPath },
								isError: false,
							} as any,
							{
								role: "toolResult",
								toolCallId: `read-${runId}`,
								toolName: "read",
								content: [{ type: "text", text: "Read file back." }],
								details: { path: scopedPath },
								isError: false,
							} as any,
						],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					},
				],
				finalText: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				error: "Subagent turn timed out after 90000ms.",
			});
			return { runId };
		},
		async startVerification() {
			counter += 1;
			const runId = `recovered-run-${counter}`;
			results.set(runId, createAgentResult(runId, "__verification__"));
			return { runId };
		},
		async waitForRun(_ctx: any, runId: string) {
			const result = results.get(runId) ?? null;
			return {
				state: { status: result?.status ?? "failed" },
				result,
			};
		},
		async stopRun() {},
	};
}

function createRetryWorkerRuntime(repoRoot: string) {
	const results = new Map<string, AgentResult>();
	let counter = 0;
	return {
		async startTask(_ctx: any, task: { id: string }, _graph: any, _state: any, options?: { cwd?: string; failureSummary?: any }) {
			counter += 1;
			const runId = `retry-run-${counter}`;
			if (options?.cwd && options.cwd !== repoRoot) {
				await fs.writeFile(path.join(options.cwd, "target.txt"), "recovered via retry\n", "utf8");
				results.set(runId, {
					...createAgentResult(runId, task.id, "completed"),
					finalText: JSON.stringify({
						taskId: task.id,
						status: "completed",
						summary: `${task.id} recovered`,
						changedFiles: ["target.txt"],
						validationsRun: ["Ran retry verification."],
						artifacts: [],
						blockers: [],
						notes: [`Retried after: ${options.failureSummary?.summary ?? "n/a"}`],
					}),
				});
			} else {
				results.set(runId, createAgentResult(runId, task.id, "failed"));
			}
			return { runId };
		},
		async startVerification() {
			counter += 1;
			const runId = `retry-run-${counter}`;
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
		expect(exitResult.content).toEqual([
			{
				type: "text",
				text: "Plan approved. Execution mode started. The main session must not execute steps manually; use get_task_graph or get_plan for status.",
			},
		]);

		await waitForCondition(() => getLatestPlanState(harness)?.status === "completed");
		const finalState = getLatestPlanState(harness);
		expect(finalState.mode).toBe("execution");
		expect(finalState.status).toBe("completed");
		expect(finalState.execution.verificationStatus).toBe("passed");
		expect(finalState.compiledTaskGraph.tasks[0].status).toBe("completed");
		expect(harness.getActiveTools()).not.toContain("write");
		expect(harness.getActiveTools()).toContain("get_plan");
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

	it("returns DONE and deactivates after successful auto-enter execution", async () => {
		const tempDir = await createTempDir();
		const previousAutoApprove = process.env.ABSOLUTE_PLAN_AUTOAPPROVE;
		process.env.ABSOLUTE_PLAN_AUTOAPPROVE = "1";
		try {
			const harness = createExtensionHarness({ cwd: tempDir });
			absolutePlanExtension(harness.pi, { workerRuntime: createFakeWorkerRuntime() as any });

			await harness.commands.get("plan").handler("", harness.ctx);
			await harness.tools.get("set_plan").execute(
				"tool-auto-set",
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
								outcome: "Planning mode toggles and executes.",
								validation: "Run runtime tests.",
							},
						],
						verification: ["Run final verification."],
						risks: [],
						status: "ready",
					},
				},
				undefined,
				undefined,
				harness.ctx,
			);

			const approved = await harness.tools.get("plan_exit").execute(
				"tool-auto-approve",
				{ decision: "approve" },
				undefined,
				undefined,
				harness.ctx,
			);
			expect(approved.content).toEqual([{ type: "text", text: "DONE" }]);
			expect(getLatestPlanState(harness)?.active).toBe(false);
			expect(harness.getActiveTools()).toContain("write");
		} finally {
			if (previousAutoApprove === undefined) {
				delete process.env.ABSOLUTE_PLAN_AUTOAPPROVE;
			} else {
				process.env.ABSOLUTE_PLAN_AUTOAPPROVE = previousAutoApprove;
			}
		}
	});

	it("auto-approves in headless mode when only AUTOENTER is enabled", async () => {
		const tempDir = await createTempDir();
		const previousAutoEnter = process.env.ABSOLUTE_PLAN_AUTOENTER;
		process.env.ABSOLUTE_PLAN_AUTOENTER = "1";
		try {
			const harness = createExtensionHarness({ cwd: tempDir });
			harness.ctx.hasUI = false;
			absolutePlanExtension(harness.pi, { workerRuntime: createFakeWorkerRuntime() as any });

			await harness.commands.get("plan").handler("", harness.ctx);
			await harness.tools.get("set_plan").execute(
				"tool-headless-set",
				{
					plan: {
						goal: "Review a plan before execution",
						assumptions: [],
						openQuestions: [],
						files: ["packages/absolute-plan/index.ts"],
						items: [
							{
								id: "review",
								title: "Prepare reviewable plan",
								outcome: "Plan exists and needs explicit approval.",
								validation: "Run review flow.",
							},
						],
						verification: ["Run review flow."],
						risks: [],
						status: "ready",
					},
				},
				undefined,
				undefined,
				harness.ctx,
			);

			const reviewed = await harness.tools.get("plan_exit").execute("tool-headless-exit", {}, undefined, undefined, harness.ctx);
			expect(reviewed.content).toEqual([{ type: "text", text: "DONE" }]);
			expect(getLatestPlanState(harness)?.active).toBe(false);
		} finally {
			if (previousAutoEnter === undefined) {
				delete process.env.ABSOLUTE_PLAN_AUTOENTER;
			} else {
				process.env.ABSOLUTE_PLAN_AUTOENTER = previousAutoEnter;
			}
		}
	});

	it("retries a failed task in a fresh worktree and merges the patch back", async () => {
		const tempDir = await createTempDir();
		await initializeGitRepo(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		harness.ctx.ui.select = async () => "Approve and compile";
		absolutePlanExtension(harness.pi, { workerRuntime: createRetryWorkerRuntime(tempDir) as any });

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.tools.get("set_plan").execute(
			"tool-retry-1",
			{
				plan: {
					goal: "Recover a failed task with retry",
					assumptions: [],
					openQuestions: [],
					files: ["target.txt"],
					items: [
						{
							id: "recover",
							title: "Recover task output",
							outcome: "Recover the target file after a failed first attempt.",
							validation: "Run retry verification.",
						},
					],
					verification: ["Run final verification."],
					risks: [],
					status: "ready",
				},
			},
			undefined,
			undefined,
			harness.ctx,
		);

		const exitResult = await harness.tools.get("plan_exit").execute("tool-retry-2", {}, undefined, undefined, harness.ctx);
		expect(exitResult.content).toEqual([
			{
				type: "text",
				text: "Plan approved. Execution mode started. The main session must not execute steps manually; use get_task_graph or get_plan for status.",
			},
		]);

		await waitForCondition(() => getLatestPlanState(harness)?.status === "completed", 1000);
		expect(await fs.readFile(path.join(tempDir, "target.txt"), "utf8")).toBe("recovered via retry\n");

		const finalState = getLatestPlanState(harness);
		expect(finalState.compiledTaskGraph.tasks[0].retry.attempt).toBe(2);
		expect(finalState.compiledTaskGraph.tasks[0].status).toBe("completed");
		expect(finalState.execution.history.some((entry: any) => entry.type === "task_retry_started")).toBe(true);
		expect(finalState.execution.history.some((entry: any) => entry.type === "task_retry_completed")).toBe(true);
		expect(finalState.execution.history.some((entry: any) => entry.type === "task_retry_patch_applied")).toBe(true);
	});

	it("recovers a timed out worker result from successful scoped file writes", async () => {
		const tempDir = await createTempDir();
		const harness = createExtensionHarness({ cwd: tempDir });
		harness.ctx.ui.select = async () => "Approve and compile";
		absolutePlanExtension(harness.pi, { workerRuntime: createRecoveredWorkerRuntime() as any });

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.tools.get("set_plan").execute(
			"tool-recovered-1",
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
							outcome: "Planning runtime file is updated.",
							validation: "Read the updated file back.",
							executionMode: "single",
						},
					],
					verification: ["Run final verification."],
					risks: [],
					status: "ready",
				},
			},
			undefined,
			undefined,
			harness.ctx,
		);

		const exitResult = await harness.tools.get("plan_exit").execute("tool-recovered-2", {}, undefined, undefined, harness.ctx);
		expect(exitResult.isError).not.toBe(true);

		await waitForCondition(() => getLatestPlanState(harness)?.status === "completed");
		const finalState = getLatestPlanState(harness);
		expect(finalState.compiledTaskGraph.tasks[0].status).toBe("completed");
		expect(finalState.compiledTaskGraph.tasks[0].changedFiles).toEqual(["packages/absolute-plan/index.ts"]);
		expect(finalState.compiledTaskGraph.tasks[0].resultSummary).toContain("did not return a final JSON payload");
	});

	it("recovers a timed out worker result when write tool paths are absolute", async () => {
		const tempDir = await createTempDir();
		const absoluteScopedPath = path.join(tempDir, "target.txt");
		const harness = createExtensionHarness({ cwd: tempDir });
		harness.ctx.ui.select = async () => "Approve and compile";
		absolutePlanExtension(harness.pi, { workerRuntime: createRecoveredWorkerRuntime(absoluteScopedPath) as any });

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.tools.get("set_plan").execute(
			"tool-recovered-abs-1",
			{
				plan: {
					goal: "Recover absolute-path writes",
					assumptions: [],
					openQuestions: [],
					files: ["target.txt"],
					items: [
						{
							id: "runtime",
							title: "Recover target file",
							outcome: "Target file is updated.",
							validation: "Read the updated file back.",
							executionMode: "single",
						},
					],
					verification: ["Run final verification."],
					risks: [],
					status: "ready",
				},
			},
			undefined,
			undefined,
			harness.ctx,
		);

		const exitResult = await harness.tools.get("plan_exit").execute(
			"tool-recovered-abs-2",
			{},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(exitResult.isError).not.toBe(true);

		await waitForCondition(() => getLatestPlanState(harness)?.status === "completed");
		const finalState = getLatestPlanState(harness);
		expect(finalState.compiledTaskGraph.tasks[0].status).toBe("completed");
		expect(finalState.compiledTaskGraph.tasks[0].changedFiles).toEqual(["target.txt"]);
	});
});
