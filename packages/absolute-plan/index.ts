import { basename, isAbsolute, relative } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentResult } from "../absolute-subagents/types.js";
import { listRunStates, readRunResult, readRunState } from "../absolute-subagents/state.js";
import { resolveRunDir, resolveStatePath, resolveStderrPath, resolveTracePath } from "../absolute-subagents/paths.js";
import { createSwarmRuntime } from "../absolute-swarm/index.js";
import type { CellTaskResult, RoleRunner, RoleRunResult, TaskCell } from "../absolute-swarm/types.js";
import {
	CONTEXT_ENTRY_TYPE,
	EXECUTION_TOOL_NAMES,
	MUTATING_TOOL_NAMES,
	PLAN_COMMAND_NAME,
	PLAN_SHORTCUT,
	READY_APPROVAL_OPTION,
	REJECT_APPROVAL_OPTION,
	REVISE_APPROVAL_OPTION,
} from "./constants.js";
import { compilePlanDoc } from "./compile.js";
import {
	applyTaskResult,
	claimTask,
	createHistoryEntry,
	findReadyTasks,
	formatTaskList,
	getExecutionStatus,
	hasWriteConflict,
	startTask,
	summarizeTaskGraph,
	updateTask,
} from "./executor.js";
import { initializePlanFile, resolvePlanFilePath, writePlanFile } from "./plan-files.js";
import { buildExecutionPrompt, buildPlanningPrompt } from "./prompt.js";
import {
	buildFailureSummary,
	buildTaskBrief,
	canRetryTask,
	createDefaultRetryState,
	formatFailureSummary,
	formatTaskBrief,
	getTaskRetryState,
} from "./retry.js";
import {
	GetCellStateSchema,
	GetRunsSchema,
	GetRunTraceSchema,
	PlanExitSchema,
	RequestUserInputSchema,
	SetPlanSchema,
	TaskResultSchema,
	TaskUpdateSchema,
} from "./schemas.js";
import { createPlanStateManager } from "./state.js";
import { readSubagentResult, startBackgroundSubagentRun, stopSubagentRun, waitForSubagentRun } from "./subagent-runtime.js";
import type {
	FailureSummary,
	PlanApprovalDecision,
	PlanDoc,
	PlanModeState,
	PlanReviewState,
	TaskBrief,
	TaskGraph,
	TaskNode,
	TaskResult,
	UserInputAnswer,
	ValidationResult,
} from "./types.js";
import { normalizePlanDoc, normalizeTaskResult, normalizeUserInputQuestions, validatePlanDoc } from "./validation.js";
import { applyWorktreePatch, buildWorktreePatch, createAttemptWorktree, removeAttemptWorktree, resolveGitRepo } from "./worktree.js";

const WORKER_WAIT_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_PREVIEW_LIMIT = 1200;

interface WorkerRuntime {
	startTask(
		ctx: ExtensionContext,
		task: TaskNode,
		graph: TaskGraph,
		state: PlanModeState,
		options?: {
			cwd?: string;
			taskBrief?: TaskBrief;
			failureSummary?: FailureSummary;
		},
	): Promise<{ runId: string }>;
	startVerification(ctx: ExtensionContext, graph: TaskGraph, state: PlanModeState): Promise<{ runId: string }>;
	waitForRun(
		ctx: ExtensionContext,
		runId: string,
		options?: { cwd?: string },
	): Promise<{ state: { status: string } | null; result: AgentResult | null }>;
	stopRun(ctx: ExtensionContext, runId: string, options?: { cwd?: string }): Promise<void>;
	readCellState(ctx: ExtensionContext, runId: string, options?: { cwd?: string }): TaskCell | undefined;
}

function textResult(text: string, details?: Record<string, unknown>, isError?: boolean) {
	return {
		isError,
		content: [{ type: "text" as const, text }],
		details: details ?? {},
	};
}

function formatValidation(validation: ValidationResult): string {
	const lines: string[] = [];
	if (validation.errors.length > 0) {
		lines.push("Errors:");
		lines.push(...validation.errors.map((error, index) => `${index + 1}. ${error}`));
	}
	if (validation.warnings.length > 0) {
		lines.push("Warnings:");
		lines.push(...validation.warnings.map((warning, index) => `${index + 1}. ${warning}`));
	}
	return lines.join("\n");
}

function getPlanSummary(state: PlanModeState): string {
	if (!state.plan) {
		return `Mode: ${state.mode}\nPlan file: ${state.planFilePath ?? "n/a"}\nNo plan has been captured yet.`;
	}
	if (state.mode === "planning") {
		return [
			`Mode: planning`,
			`Plan file: ${state.planFilePath ?? "n/a"}`,
			`Goal: ${state.plan.goal}`,
			`Status: ${state.plan.status}`,
			`Items: ${state.plan.items.length}`,
			`Validation: ${state.validation?.valid ? "valid" : "pending"}`,
			`Review pending: ${state.review?.pending ? "yes" : "no"}`,
			...(state.feedback ? [`Feedback: ${state.feedback}`] : []),
		].join("\n");
	}
	return [
		`Mode: execution`,
		`Plan file: ${state.planFilePath ?? "n/a"}`,
		`Goal: ${state.plan.goal}`,
		`Runtime status: ${state.status}`,
		summarizeTaskGraph(state.compiledTaskGraph ?? { id: "n/a", goal: state.plan.goal, verification: [], tasks: [] }),
	].join("\n");
}

function buildReviewText(
	state: PlanModeState,
	preview: string,
	validation: ValidationResult,
	validationSummary: string,
): string {
	const graphSummary = state.compiledTaskGraph ? summarizeTaskGraph(state.compiledTaskGraph) : "No compiled task graph yet.";
	return [
		`Plan file: ${state.planFilePath ?? "n/a"}`,
		`Plan goal: ${state.plan?.goal ?? "n/a"}`,
		`Validation: ${validation.valid ? "valid" : "invalid"}`,
		"",
		validationSummary,
		"",
		graphSummary,
		"",
		preview,
	].join("\n");
}

function createReviewState(preview: string, validation: ValidationResult, feedback?: string, lastDecision?: PlanReviewState["lastDecision"]): PlanReviewState {
	return {
		pending: true,
		preview,
		validationSummary: buildValidationText(validation),
		requestedAt: Date.now(),
		feedback,
		lastDecision,
	};
}

async function readPlanPreview(planFilePath: string | undefined): Promise<string> {
	if (!planFilePath) {
		return "Plan file is not available.";
	}
	try {
		const content = await readFile(planFilePath, "utf8");
		if (content.length <= APPROVAL_PREVIEW_LIMIT) {
			return content;
		}
		return `${content.slice(0, APPROVAL_PREVIEW_LIMIT).trimEnd()}\n\n...`;
	} catch (error) {
		return `Unable to read plan file: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function requestPlanApproval(
	ctx: ExtensionContext,
	state: PlanModeState,
	validation: ValidationResult,
): Promise<{ decision: PlanApprovalDecision; preview: string; feedback?: string }> {
	const preview = await readPlanPreview(state.planFilePath);
	if (!ctx.hasUI) {
		return { decision: "cancel", preview };
	}
	const prompt = buildReviewText(state, preview, validation, buildValidationText(validation));
	const choice = await ctx.ui.select(prompt, [READY_APPROVAL_OPTION, REVISE_APPROVAL_OPTION, REJECT_APPROVAL_OPTION]);
	if (choice === READY_APPROVAL_OPTION) {
		return { decision: "approve", preview };
	}
	if (choice === REVISE_APPROVAL_OPTION) {
		const feedback = await ctx.ui.input("What should change in the plan?", state.feedback ?? "");
		return { decision: "revise", preview, feedback: feedback === null ? state.feedback : String(feedback).trim() || undefined };
	}
	if (choice === REJECT_APPROVAL_OPTION) {
		const feedback = await ctx.ui.input("Why reject this plan?", state.feedback ?? "");
		return { decision: "reject", preview, feedback: feedback === null ? state.feedback : String(feedback).trim() || undefined };
	}
	return { decision: "cancel", preview };
}

function getAutoEnterPlanConfig() {
	const enabled = process.env.ABSOLUTE_PLAN_AUTOENTER === "1";
	const requestedPath = process.env.ABSOLUTE_PLAN_AUTOENTER_PATH?.trim();
	return {
		enabled,
		requestedPath: requestedPath && requestedPath.length > 0 ? requestedPath : "",
	};
}

function getAutoApprovePlanConfig() {
	return {
		enabled: process.env.ABSOLUTE_PLAN_AUTOAPPROVE === "1",
	};
}

function extractJsonCandidate(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		// Continue.
	}

	const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		const candidate = fencedMatch[1].trim();
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			// Continue.
		}
	}

	const startIndex = trimmed.indexOf("{");
	const endIndex = trimmed.lastIndexOf("}");
	if (startIndex >= 0 && endIndex > startIndex) {
		const candidate = trimmed.slice(startIndex, endIndex + 1);
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			return null;
		}
	}
	return null;
}

function normalizePlanApprovalDecision(value: unknown): "approve" | "revise" | "reject" | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().replace(/^"+|"+$/g, "");
	if (normalized === "approve" || normalized === "revise" || normalized === "reject") {
		return normalized;
	}
	return undefined;
}

type ToolResultLike = {
	toolName?: string;
	isError?: boolean;
	details?: {
		path?: string;
		exitCode?: number;
	};
	content?: Array<{
		type?: string;
		text?: string;
	}>;
};

function collectTurnMessages(result: AgentResult | null) {
	if (!result) {
		return [];
	}
	return result.turns.flatMap((turn) => turn.messages);
}

function getToolResults(result: AgentResult | null, toolName: string): ToolResultLike[] {
	return collectTurnMessages(result)
		.filter((message) => {
			if (message.role !== "toolResult") {
				return false;
			}
			return ((message as unknown as ToolResultLike).toolName ?? "") === toolName;
		})
		.map((message) => message as unknown as ToolResultLike)
		.filter((message) => {
			if (message.toolName !== toolName) {
				return false;
			}
			return true;
		});
}

function normalizeToolPath(filePath: string, cwd?: string): string[] {
	const normalized = filePath.trim();
	if (!normalized) {
		return [];
	}
	if (!cwd || !isAbsolute(normalized)) {
		return [normalized];
	}
	const relativePath = relative(cwd, normalized);
	return relativePath && !relativePath.startsWith("..") ? [normalized, relativePath] : [normalized];
}

function getSuccessfulWritePaths(result: AgentResult | null, cwd?: string): string[] {
	return Array.from(
		new Set(
			getToolResults(result, "write")
				.filter((message) => !message.isError && typeof message.details?.path === "string")
				.flatMap((message) => normalizeToolPath(message.details?.path?.trim() ?? "", cwd))
				.filter((filePath) => filePath.length > 0),
		),
	);
}

function getValidationEvidence(result: AgentResult | null, cwd?: string): string[] {
	const validations: string[] = [];
	for (const message of getToolResults(result, "read")) {
		if (message.isError || typeof message.details?.path !== "string") {
			continue;
		}
		for (const filePath of normalizeToolPath(message.details.path, cwd)) {
			validations.push(`Read-back check for ${basename(filePath)}.`);
		}
	}
	for (const message of getToolResults(result, "bash")) {
		if (message.isError || message.details?.exitCode !== 0) {
			continue;
		}
		validations.push("Shell validation completed successfully.");
	}
	return Array.from(new Set(validations));
}

function synthesizeTaskResultFromToolActivity(
	task: TaskNode,
	result: AgentResult | null,
	fallbackStatus?: string,
	cwd?: string,
): TaskResult | null {
	if (!result || fallbackStatus === "stopped") {
		return null;
	}
	const writePaths = getSuccessfulWritePaths(result, cwd);
	if (writePaths.length === 0) {
		return null;
	}
	const scopedWritePaths = task.writeScope.filter((path) => writePaths.includes(path));
	if (scopedWritePaths.length !== task.writeScope.length) {
		return null;
	}
	const validationsRun = getValidationEvidence(result, cwd);
	return {
		taskId: task.id,
		status: "completed",
		summary:
			result.finalText.trim() ||
			`Completed ${task.title} using scoped file updates but the worker did not return a final JSON payload before exit.`,
		changedFiles: scopedWritePaths,
		validationsRun: validationsRun.length > 0 ? validationsRun : ["Scoped file update completed."],
		artifacts: scopedWritePaths,
		blockers: [],
		notes: result.error ? [result.error] : ["Recovered task result from worker tool activity."],
	};
}

function parseTaskResultFromAgentResult(
	task: TaskNode,
	result: AgentResult | null,
	fallbackStatus?: string,
	cwd?: string,
): TaskResult {
	if (!result) {
		return {
			taskId: task.id,
			status: "failed",
			summary: "Subagent did not produce a result.",
			changedFiles: [],
			validationsRun: [],
			artifacts: [],
			blockers: ["Missing subagent result."],
			notes: [],
		};
	}

	const jsonCandidate = extractJsonCandidate(result.finalText);
	if (jsonCandidate) {
		const parsed = normalizeTaskResult(JSON.parse(jsonCandidate));
		if (parsed.taskId && parsed.summary) {
			return {
				...parsed,
				taskId: parsed.taskId || task.id,
			};
		}
	}

	if (fallbackStatus === "stopped") {
		return {
			taskId: task.id,
			status: "blocked",
			summary: result.finalText.trim() || "Execution was stopped before completion.",
			changedFiles: [],
			validationsRun: [],
			artifacts: [],
			blockers: ["Execution stopped."],
			notes: [],
		};
	}

	const synthesized = synthesizeTaskResultFromToolActivity(task, result, fallbackStatus, cwd);
	if (synthesized) {
		return synthesized;
	}

	const failureStatus = result.status === "failed" ? "failed" : "needs_review";
	return {
		taskId: task.id,
		status: failureStatus,
		summary: result.finalText.trim() || "Worker returned an unstructured result.",
		changedFiles: [],
		validationsRun: [],
		artifacts: [],
		blockers: failureStatus === "failed" ? [result.error || "Worker failed."] : ["Worker did not return structured JSON."],
		notes: result.error ? [result.error] : [],
	};
}

function createSyntheticAgentResult(id: string, finalResult: CellTaskResult, agent = "swarm"): AgentResult {
	return {
		id,
		agent,
		mode: "background",
		status: finalResult.status === "failed" ? "failed" : "completed",
		sessionDir: "",
		turns: [],
		finalText: JSON.stringify(finalResult),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		error: finalResult.status === "failed" ? finalResult.summary : undefined,
	};
}

function buildWorkerTaskPrompt(
	task: TaskNode,
	graph: TaskGraph,
	state: PlanModeState,
	options?: { taskBrief?: TaskBrief; failureSummary?: FailureSummary },
): string {
	const taskBrief = options?.taskBrief ?? buildTaskBrief(graph, task);
	return [
		`Task ID: ${task.id}`,
		`Task title: ${task.title}`,
		`Task spec: ${task.spec}`,
		`Plan goal: ${graph.goal}`,
		`Plan file: ${state.planFilePath ?? "n/a"}`,
		`Write scope: ${task.writeScope.length > 0 ? task.writeScope.join(", ") : "n/a"}`,
		`Validation criteria: ${task.validation.join(" | ")}`,
		`Dependencies already completed: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}`,
		"",
		`Task brief:\n${formatTaskBrief(taskBrief)}`,
		`Failure summary:\n${formatFailureSummary(options?.failureSummary)}`,
		"",
		"Return exactly one JSON object with this shape:",
		'{"taskId":"...", "status":"completed|blocked|failed|needs_review", "summary":"...", "changedFiles":["..."], "validationsRun":["..."], "artifacts":["..."], "blockers":["..."], "notes":["..."]}',
		"",
		"Requirements:",
		"- The prompt already contains the task context. Do not re-read the plan file or inspect unrelated files unless absolutely required.",
		"- Prefer the shortest path: create the scoped file, run minimal validation, then return the final JSON immediately.",
		"- Treat validation criteria as literal acceptance checks. If they name required headings, labels, or phrases, reproduce those phrases verbatim in the artifact whenever possible, preserving spelling and casing.",
		"- Your final assistant message must be the JSON object only. Do not wrap it in markdown and do not add prose before or after it.",
		"- After you have enough evidence to satisfy validation, stop calling tools and emit the JSON response.",
		"- Use the provided taskId.",
		"- Only create or modify files inside the provided Write scope.",
		"- Do not introduce extra files, tooling, or refactors outside this task.",
		"- If you cannot safely finish, return blocked or needs_review instead of guessing.",
		"- validationsRun must list the checks or tests you actually performed.",
		"- Keep summary concise and factual.",
	].join("\n");
}

function buildVerificationPrompt(graph: TaskGraph, state: PlanModeState): string {
	return [
		`Plan goal: ${graph.goal}`,
		`Plan file: ${state.planFilePath ?? "n/a"}`,
		`Verification requirements: ${graph.verification.join(" | ")}`,
		`Completed tasks: ${graph.tasks.filter((task) => task.status === "completed").map((task) => task.id).join(", ")}`,
		"",
		"Return exactly one JSON object with this shape:",
		'{"taskId":"__verification__", "status":"completed|blocked|failed|needs_review", "summary":"...", "changedFiles":["..."], "validationsRun":["..."], "artifacts":["..."], "blockers":["..."], "notes":["..."]}',
		"",
		"Treat verification requirements as literal acceptance checks. When they mention required headings, labels, or phrases, verify those exact phrases case-sensitively unless the requirement explicitly allows variants.",
		"Only return completed if the overall plan verification has passed.",
	].join("\n");
}

function createDefaultWorkerRuntime(): WorkerRuntime {
	const roleRunnerFactory = (baseCwd: string): RoleRunner => ({
		async startRole(role, prompt) {
			const started = await startBackgroundSubagentRun(baseCwd, {
				agent: role === "implementer" ? "worker" : role,
				task: prompt,
				mode: "background",
			});
			return { runId: started.runId };
		},
		async waitForRun(runId) {
			const waited = await waitForSubagentRun(baseCwd, runId, { timeoutMs: WORKER_WAIT_TIMEOUT_MS });
			const result = waited.result ?? readSubagentResult(baseCwd, runId);
			const status = waited.state?.status;
			const mappedStatus: RoleRunResult["status"] =
				status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed";
			return {
				status: mappedStatus,
				finalText: result?.finalText ?? "",
				error: result?.error,
			};
		},
		async stopRun(runId) {
			stopSubagentRun(baseCwd, runId);
		},
	});

	const swarmRuntimeByCwd = new Map<string, ReturnType<typeof createSwarmRuntime>>();
	const getSwarmRuntime = (baseCwd: string) => {
		let runtime = swarmRuntimeByCwd.get(baseCwd);
		if (!runtime) {
			runtime = createSwarmRuntime({ roleRunner: roleRunnerFactory(baseCwd) });
			swarmRuntimeByCwd.set(baseCwd, runtime);
		}
		return runtime;
	};

	return {
		async startTask(ctx, task, graph, state, options) {
			const baseCwd = options?.cwd ?? ctx.cwd;
			const taskBrief = options?.taskBrief ?? buildTaskBrief(graph, task);
			if (task.executionMode === "swarm") {
				const runtime = getSwarmRuntime(baseCwd);
				const cell = runtime.createCell({
					id: task.id,
					title: task.title,
					spec: task.spec,
					writeScope: [...task.writeScope],
					validation: [...task.validation],
					risk: task.risk,
					hydrate: task.hydrate,
					complexity: task.complexity,
					notes: [...task.notes],
					taskBrief,
					failureSummary: options?.failureSummary
						? {
								...options.failureSummary,
								blockers: [...options.failureSummary.blockers],
								validationsRun: [...options.failureSummary.validationsRun],
								changedFiles: [...options.failureSummary.changedFiles],
								notes: [...options.failureSummary.notes],
						  }
						: undefined,
				});
				void runtime.runCell(cell.id);
				return { runId: cell.id };
			}
			const prompt = buildWorkerTaskPrompt(task, graph, state, {
				taskBrief,
				failureSummary: options?.failureSummary,
			});
			const started = await startBackgroundSubagentRun(baseCwd, {
				agent: "worker",
				task: prompt,
				mode: "background",
			});
			return { runId: started.runId };
		},
		async waitForRun(ctx, runId, options) {
			const baseCwd = options?.cwd ?? ctx.cwd;
			const runtime = getSwarmRuntime(baseCwd);
			if (runtime.hasCell(runId)) {
				const cell = await runtime.runCell(runId);
				const result = runtime.collectCellResult(runId);
				return {
					state: { status: cell.status === "failed" ? "failed" : cell.status === "blocked" ? "stopped" : "completed" },
					result: result ? createSyntheticAgentResult(runId, result) : null,
				};
			}
			return waitForSubagentRun(baseCwd, runId, { timeoutMs: WORKER_WAIT_TIMEOUT_MS });
		},
		async startVerification(ctx, graph, state) {
			const started = await startBackgroundSubagentRun(ctx.cwd, {
				agent: "verifier",
				task: buildVerificationPrompt(graph, state),
				mode: "background",
			});
			return { runId: started.runId };
		},
		async stopRun(ctx, runId, options) {
			const baseCwd = options?.cwd ?? ctx.cwd;
			const runtime = getSwarmRuntime(baseCwd);
			if (runtime.hasCell(runId)) {
				await runtime.stopCell(runId);
				return;
			}
			stopSubagentRun(baseCwd, runId);
		},
		readCellState(ctx, runId, options) {
			const baseCwd = options?.cwd ?? ctx.cwd;
			return getSwarmRuntime(baseCwd).readCellState(runId);
		},
	};
}

function buildValidationText(validation: ValidationResult): string {
	if (validation.valid && validation.warnings.length === 0) {
		return "Plan is valid.";
	}
	return formatValidation(validation);
}

function formatTail(text: string, maxLines = 40): string {
	const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
	return lines.slice(-maxLines).join("\n");
}

function findTaskForRun(state: PlanModeState, runId: string): TaskNode | undefined {
	return state.compiledTaskGraph?.tasks.find((task) => task.owner === runId);
}

async function buildRunsView(state: PlanModeState, ctx: ExtensionContext, workerRuntime: WorkerRuntime) {
	const cwd = ctx.cwd;
	const runs = listRunStates(cwd);
	const serialized = runs.map((run) => {
		const result = readRunResult(run.resultPath);
		const task = findTaskForRun(state, run.id);
		const cell = task?.executionMode === "swarm" ? workerRuntime.readCellState(ctx, run.id) : undefined;
		return {
			runId: run.id,
			taskId: task?.id,
			status: run.status,
			mode: run.mode,
			agent: run.agent,
			attempt: task?.retry.attempt,
			executionMode: task?.executionMode,
			currentPhase: cell?.currentPhase,
			pid: run.pid,
			updatedAt: run.updatedAt,
			error: result?.error ?? run.lastError,
			finalText: result?.finalText ?? "",
		};
	});
	const text =
		serialized.length === 0
			? "No subagent runs found."
			: serialized
					.map((run) =>
						[
							`${run.runId} [${run.status}]`,
							run.taskId ? `task=${run.taskId}` : undefined,
							run.executionMode ? `mode=${run.executionMode}` : undefined,
							run.attempt ? `attempt=${run.attempt}` : undefined,
							run.agent ? `agent=${run.agent}` : undefined,
						]
							.filter(Boolean)
							.join(" "),
					)
					.join("\n");
	return { text, details: { runs: serialized } };
}

async function buildRunTraceView(state: PlanModeState, cwd: string, runId: string, raw = false) {
	const runDir = resolveRunDir(cwd, runId);
	const runState = readRunState(resolveStatePath(runDir));
	const task = findTaskForRun(state, runId);
	if (!runState) {
		return textResult(`Unknown run: ${runId}`, undefined, true);
	}
	const result = readRunResult(runState.resultPath);
	const tracePath = resolveTracePath(runDir);
	const stderrPath = resolveStderrPath(runDir);
	let traceTail = "";
	let stderrTail = "";
	try {
		traceTail = formatTail(await readFile(tracePath, "utf8"));
	} catch {
		traceTail = "";
	}
	try {
		stderrTail = formatTail(await readFile(stderrPath, "utf8"));
	} catch {
		stderrTail = "";
	}
	const summary = [
		`Run: ${runId}`,
		`Status: ${runState.status}`,
		`Agent: ${runState.agent}`,
		`Task: ${task?.id ?? "n/a"}`,
		`Updated: ${new Date(runState.updatedAt).toISOString()}`,
		result?.error || runState.lastError ? `Error: ${result?.error ?? runState.lastError}` : undefined,
		result?.finalText ? `Final text: ${result.finalText.slice(0, 400)}` : undefined,
	].filter(Boolean);
	const text = raw
		? [summary.join("\n"), "", "--- trace tail ---", traceTail || "(empty)", "", "--- stderr tail ---", stderrTail || "(empty)"].join(
				"\n",
		  )
		: [
				summary.join("\n"),
				"",
				`Trace tail:\n${traceTail || "(empty)"}`,
				stderrTail ? `\nStderr tail:\n${stderrTail}` : "",
		  ].join("\n");
	return textResult(text, {
		run: {
			runId,
			taskId: task?.id,
			status: runState.status,
			agent: runState.agent,
			updatedAt: runState.updatedAt,
			error: result?.error ?? runState.lastError,
			finalText: result?.finalText ?? "",
			traceTail,
			stderrTail,
		},
	});
}

function buildCellStateView(state: PlanModeState, taskId: string, cell: TaskCell | undefined) {
	if (!cell) {
		return textResult(`No swarm cell is available for task ${taskId}.`, undefined, true);
	}
	const header = [
		`Cell: ${cell.id}`,
		`Task: ${taskId}`,
		`Status: ${cell.status}`,
		`Phase: ${cell.currentPhase ?? "n/a"}`,
	].join("\n");
	const members = cell.members
		.map((member) => `- ${member.role}: ${member.status}${member.runId ? ` (${member.runId})` : ""}`)
		.join("\n");
	const blackboard = cell.blackboard.map((entry) => `- [${entry.type}] ${entry.author}: ${entry.content}`).slice(-10).join("\n");
	const mailbox = cell.mailbox
		.map((message) => `- ${message.from} -> ${message.to} [${message.kind}]: ${message.content}`)
		.slice(-10)
		.join("\n");
	return textResult(
		[
			header,
			"",
			`Members:\n${members || "(none)"}`,
			"",
			`Blackboard:\n${blackboard || "(empty)"}`,
			"",
			`Mailbox:\n${mailbox || "(empty)"}`,
		].join("\n"),
		{ cell },
	);
}

export default function absolutePlanExtension(pi: ExtensionAPI, options?: { workerRuntime?: WorkerRuntime }) {
	const stateManager = createPlanStateManager(pi);
	const workerRuntime = options?.workerRuntime ?? createDefaultWorkerRuntime();
	let executionPromise: Promise<void> | null = null;

	const ensureExecutionLoop = (ctx: ExtensionContext) => {
		if (executionPromise) {
			return;
		}
		const currentState = stateManager.getState();
		if (!currentState.active || currentState.mode !== "execution" || currentState.execution?.paused) {
			return;
		}
		executionPromise = runExecutionLoop(ctx)
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				stateManager.mutate(ctx, (state) => ({
					...state,
					status: "failed",
					execution: state.execution
						? {
								...state.execution,
								lastError: message,
								currentRunId: undefined,
								currentTaskId: undefined,
								runningRunIds: [],
								history: [...state.execution.history, createHistoryEntry("task_failed", message)],
						  }
						: state.execution,
				}));
				ctx.ui.notify(`Plan execution crashed: ${message}`, "error");
			})
			.finally(() => {
				executionPromise = null;
				const refreshedState = stateManager.getState();
				if (
					refreshedState.active &&
					refreshedState.mode === "execution" &&
					!refreshedState.execution?.paused &&
					refreshedState.status === "executing"
				) {
					ensureExecutionLoop(ctx);
				}
			});
	};

	const maybeAutoEnterPlanning = async (ctx: ExtensionContext) => {
		const autoEnter = getAutoEnterPlanConfig();
		if (!autoEnter.enabled) {
			return;
		}
		const state = stateManager.getState();
		if (state.active) {
			return;
		}
		const planFilePath = await resolvePlanFilePath(ctx, autoEnter.requestedPath);
		await initializePlanFile(planFilePath);
		stateManager.enterPlanning(ctx, planFilePath);
	};

	async function executeRetryAttempt(
		ctx: ExtensionContext,
		task: TaskNode,
		graph: TaskGraph,
		state: PlanModeState,
		failureSummary: FailureSummary,
	): Promise<{ taskResult: TaskResult; runId?: string; worktreePath?: string; baseRef?: string; patchApplied?: boolean }> {
		const repo = resolveGitRepo(ctx.cwd);
		if (!repo) {
			return {
				taskResult: {
					...failureSummaryToTaskResult(task.id, failureSummary),
					status: "failed",
					summary: `${failureSummary.summary} Retry requires a git repository.`,
					blockers: [...failureSummary.blockers, "Retry requires a git repository."],
					notes: [...failureSummary.notes],
				},
			};
		}

		const nextAttempt = getTaskRetryState(task).attempt + 1;
		const attempt = createAttemptWorktree(repo, task.id, nextAttempt);
		try {
			const taskBrief = buildTaskBrief(graph, task);
			const started = await workerRuntime.startTask(ctx, task, graph, state, {
				cwd: attempt.worktreePath,
				taskBrief,
				failureSummary: {
					...failureSummary,
					attempt: nextAttempt,
					worktreePath: attempt.worktreePath,
					baseRef: attempt.baseRef,
				},
			});
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				compiledTaskGraph: currentState.compiledTaskGraph
					? updateTask(currentState.compiledTaskGraph, task.id, (currentTask) => ({
							...currentTask,
							owner: started.runId,
							retry: {
								...getTaskRetryState(currentTask),
								attempt: nextAttempt,
								status: "retrying",
								lastFailureKind: failureSummary.kind,
								lastFailureSummary: {
									...failureSummary,
									worktreePath: attempt.worktreePath,
									baseRef: attempt.baseRef,
								},
								lastAttemptBaseRef: attempt.baseRef,
								lastAttemptWorktreePath: attempt.worktreePath,
							},
					  }))
					: currentState.compiledTaskGraph,
				execution: currentState.execution
					? {
							...currentState.execution,
							currentTaskId: task.id,
							currentRunId: started.runId,
							runningRunIds: [...currentState.execution.runningRunIds, started.runId],
					  }
					: currentState.execution,
			}));
			const waited = await workerRuntime.waitForRun(ctx, started.runId, { cwd: attempt.worktreePath });
			const agentResult = waited.result ?? readSubagentResult(attempt.worktreePath, started.runId);
			const taskResult = parseTaskResultFromAgentResult(task, agentResult, waited.state?.status, attempt.worktreePath);
			if (taskResult.status === "completed") {
				const { patch, changedFiles } = buildWorktreePatch(attempt);
				if (!patch.trim()) {
					return {
						taskResult: {
							...taskResult,
							status: "blocked",
							summary: "Retry completed without producing a patch to merge back.",
							blockers: ["Retry completed without producing a patch to merge back."],
						},
						runId: started.runId,
						worktreePath: attempt.worktreePath,
						baseRef: attempt.baseRef,
					};
				}
				try {
					applyWorktreePatch(repo.repoRoot, patch);
				} catch (error) {
					return {
						taskResult: {
							taskId: task.id,
							status: "failed",
							summary: error instanceof Error ? error.message : String(error),
							changedFiles,
							validationsRun: [...taskResult.validationsRun],
							artifacts: [...taskResult.artifacts],
							blockers: [error instanceof Error ? error.message : String(error)],
							notes: [...(taskResult.notes ?? []), `Patch merge-back failed from ${attempt.worktreePath}.`],
						},
						runId: started.runId,
						worktreePath: attempt.worktreePath,
						baseRef: attempt.baseRef,
					};
				}
				removeAttemptWorktree(attempt);
				return {
					taskResult: {
						...taskResult,
						changedFiles: taskResult.changedFiles.length > 0 ? taskResult.changedFiles : changedFiles,
						notes: [...(taskResult.notes ?? []), `Recovered via retry attempt ${nextAttempt}.`],
					},
					runId: started.runId,
					worktreePath: attempt.worktreePath,
					baseRef: attempt.baseRef,
					patchApplied: true,
				};
			}
			return {
				taskResult,
				runId: started.runId,
				worktreePath: attempt.worktreePath,
				baseRef: attempt.baseRef,
			};
		} catch (error) {
			return {
				taskResult: {
					taskId: task.id,
					status: "failed",
					summary: error instanceof Error ? error.message : String(error),
					changedFiles: [],
					validationsRun: [],
					artifacts: [],
					blockers: [error instanceof Error ? error.message : String(error)],
					notes: [`Retry attempt worktree: ${attempt.worktreePath}`],
				},
				worktreePath: attempt.worktreePath,
				baseRef: attempt.baseRef,
			};
		}
	}

	function failureSummaryToTaskResult(taskId: string, failureSummary: FailureSummary): TaskResult {
		return {
			taskId,
			status: failureSummary.kind,
			summary: failureSummary.summary,
			changedFiles: [...failureSummary.changedFiles],
			validationsRun: [...failureSummary.validationsRun],
			artifacts: [],
			blockers: [...failureSummary.blockers],
			notes: [...failureSummary.notes],
		};
	}

	async function runVerification(ctx: ExtensionContext) {
		const state = stateManager.getState();
		if (!state.compiledTaskGraph || !state.execution) {
			return;
		}
		stateManager.mutate(ctx, (currentState) => ({
			...currentState,
			status: "executing",
			execution: currentState.execution
				? {
						...currentState.execution,
						verificationStatus: "running",
						history: [
							...currentState.execution.history,
							createHistoryEntry("verification_started", "Verification started."),
						],
				  }
				: currentState.execution,
		}));

		const started = await workerRuntime.startVerification(ctx, state.compiledTaskGraph, state);

		stateManager.mutate(ctx, (currentState) => ({
			...currentState,
			execution: currentState.execution
				? {
						...currentState.execution,
						currentRunId: started.runId,
						runningRunIds: [...currentState.execution.runningRunIds, started.runId],
				  }
				: currentState.execution,
		}));

		const waited = await workerRuntime.waitForRun(ctx, started.runId);
		const verificationResult = parseTaskResultFromAgentResult(
			{
				id: "__verification__",
				title: "Verify plan execution",
				spec: "Run final verification.",
				status: "in_progress",
				dependsOn: [],
				writeScope: [],
				validation: [...state.compiledTaskGraph.verification],
				executionMode: "single",
				owner: started.runId,
				artifacts: [],
				changedFiles: [],
				blockers: [],
				notes: [],
				hydrate: false,
				complexity: {
					level: "medium",
					score: 4,
					reasoning: "final verification step",
				},
				retry: createDefaultRetryState(),
			},
			waited.result ?? readSubagentResult(ctx.cwd, started.runId),
			waited.state?.status,
			ctx.cwd,
		);

		stateManager.mutate(ctx, (currentState) => {
			if (!currentState.execution) {
				return currentState;
			}
			const runningRunIds = currentState.execution.runningRunIds.filter((runId) => runId !== started.runId);
			if (verificationResult.status === "completed" && verificationResult.validationsRun.length > 0) {
				return {
					...currentState,
					status: "completed",
					execution: {
						...currentState.execution,
						currentRunId: undefined,
						currentTaskId: undefined,
						runningRunIds,
						verificationStatus: "passed",
						history: [
							...currentState.execution.history,
							createHistoryEntry("verification_passed", verificationResult.summary, { runId: started.runId }),
							createHistoryEntry("execution_completed", "Plan execution completed."),
						],
					},
				};
			}
			return {
				...currentState,
				status: "blocked",
				execution: {
					...currentState.execution,
					currentRunId: undefined,
					currentTaskId: undefined,
					runningRunIds,
					verificationStatus: "failed",
					lastError: verificationResult.summary,
					history: [
						...currentState.execution.history,
						createHistoryEntry("verification_failed", verificationResult.summary, { runId: started.runId }),
					],
				},
			};
		});

		const finalState = stateManager.getState();
		if (finalState.status === "completed") {
			ctx.ui.notify("Plan execution completed.", "info");
		} else {
			ctx.ui.notify("Plan execution blocked during final verification.", "error");
		}
	}

	async function runExecutionLoop(ctx: ExtensionContext) {
		while (true) {
			const state = stateManager.getState();
			if (!state.active || state.mode !== "execution" || state.execution?.paused || !state.compiledTaskGraph || !state.execution) {
				return;
			}

			const status = getExecutionStatus(state.compiledTaskGraph, state.execution.verificationStatus);
			if (status === "failed") {
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					status: "failed",
				}));
				ctx.ui.notify("Plan execution failed.", "error");
				return;
			}
			if (status === "blocked") {
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					status: "blocked",
				}));
				ctx.ui.notify("Plan execution is blocked.", "error");
				return;
			}
			if (status === "ready_for_verification") {
				await runVerification(ctx);
				return;
			}
			if (status === "completed") {
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					status: "completed",
				}));
				return;
			}

			const taskGraph = state.compiledTaskGraph;
			const readyTasks = findReadyTasks(taskGraph).filter((task) => !hasWriteConflict(task, taskGraph));
			const nextTask = readyTasks[0];
			if (!nextTask) {
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					status: "blocked",
					execution: currentState.execution
						? {
								...currentState.execution,
								lastError: "No ready tasks remain, but the graph is not complete.",
						  }
						: currentState.execution,
				}));
				ctx.ui.notify("Plan execution blocked: no ready tasks remain.", "error");
				return;
			}

			const started = await workerRuntime.startTask(ctx, nextTask, state.compiledTaskGraph, state);
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				status: "executing",
				compiledTaskGraph: currentState.compiledTaskGraph
					? updateTask(
							startTask(claimTask(currentState.compiledTaskGraph, nextTask.id, started.runId), nextTask.id, started.runId),
							nextTask.id,
							(task) => ({
								...task,
								retry: {
									...getTaskRetryState(task),
									attempt: getTaskRetryState(task).attempt + 1,
									status: "idle",
								},
							}),
					  )
					: currentState.compiledTaskGraph,
				execution: currentState.execution
					? {
							...currentState.execution,
							currentTaskId: nextTask.id,
							currentRunId: started.runId,
							runningRunIds: [...currentState.execution.runningRunIds, started.runId],
							lastError: undefined,
							history: [
								...currentState.execution.history,
								createHistoryEntry("task_claimed", `Claimed ${nextTask.id}.`, { taskId: nextTask.id, runId: started.runId }),
								createHistoryEntry("task_started", `Started ${nextTask.id}.`, { taskId: nextTask.id, runId: started.runId }),
							],
					  }
					: currentState.execution,
			}));
			ctx.ui.notify(`Started task ${nextTask.id}.`, "info");

			const waited = await workerRuntime.waitForRun(ctx, started.runId);
			const agentResult = waited.result ?? readSubagentResult(ctx.cwd, started.runId);
			let taskResult = parseTaskResultFromAgentResult(nextTask, agentResult, waited.state?.status, ctx.cwd);
			let resultRunId = started.runId;
			let retryTriggered = false;
			let retryPatchApplied = false;
			let lastFailureSummary: FailureSummary | undefined;
			let lastAttemptBaseRef: string | undefined;
			let lastAttemptWorktreePath: string | undefined;

			const retrySourceTask = stateManager.getState().compiledTaskGraph?.tasks.find((task) => task.id === nextTask.id) ?? nextTask;
			if (canRetryTask(retrySourceTask, taskResult)) {
				retryTriggered = true;
				const failureSummary = buildFailureSummary(retrySourceTask, taskResult);
				lastFailureSummary = failureSummary;
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					compiledTaskGraph: currentState.compiledTaskGraph
						? updateTask(currentState.compiledTaskGraph, nextTask.id, (task) => ({
								...task,
								owner: undefined,
								retry: {
									...getTaskRetryState(task),
									status: "retrying",
									lastFailureKind: failureSummary.kind,
									lastFailureSummary: failureSummary,
								},
						  }))
						: currentState.compiledTaskGraph,
					execution: currentState.execution
						? {
								...currentState.execution,
								currentRunId: undefined,
								runningRunIds: currentState.execution.runningRunIds.filter((runId) => runId !== started.runId),
								history: [
									...currentState.execution.history,
									createHistoryEntry("task_retry_started", `Retrying ${nextTask.id} after ${failureSummary.kind}.`, {
										taskId: nextTask.id,
										runId: started.runId,
									}),
								],
						  }
						: currentState.execution,
				}));
				ctx.ui.notify(`Retrying task ${nextTask.id} in a fresh worktree.`, "info");

				const retryAttempt = await executeRetryAttempt(ctx, retrySourceTask, stateManager.getState().compiledTaskGraph ?? taskGraph, state, failureSummary);
				taskResult = retryAttempt.taskResult;
				resultRunId = retryAttempt.runId ?? started.runId;
				retryPatchApplied = retryAttempt.patchApplied === true;
				lastAttemptBaseRef = retryAttempt.baseRef;
				lastAttemptWorktreePath = retryAttempt.worktreePath;
				if (retryAttempt.worktreePath || retryAttempt.baseRef) {
					lastFailureSummary = {
						...failureSummary,
						worktreePath: retryAttempt.worktreePath,
						baseRef: retryAttempt.baseRef,
					};
				}
			}

			stateManager.mutate(ctx, (currentState) => {
				if (!currentState.compiledTaskGraph || !currentState.execution) {
					return currentState;
				}
				const graphWithRetry = updateTask(currentState.compiledTaskGraph, nextTask.id, (task) => {
					const retry = getTaskRetryState(task);
					const effectiveAttempt =
						retryTriggered && resultRunId === started.runId ? Math.min(retry.maxAttempts, retry.attempt + 1) : retry.attempt;
					const isRetryTerminal =
						(taskResult.status === "failed" || taskResult.status === "blocked") &&
						(retryTriggered || effectiveAttempt >= retry.maxAttempts);
					return {
						...task,
						owner: undefined,
						retry: {
							...retry,
							attempt: effectiveAttempt,
							status:
								taskResult.status === "completed"
									? "idle"
									: taskResult.status === "failed" || taskResult.status === "blocked"
										? isRetryTerminal
											? "exhausted"
											: retry.status
										: "idle",
							lastFailureKind:
								taskResult.status === "failed" || taskResult.status === "blocked" ? taskResult.status : retry.lastFailureKind,
							lastFailureSummary:
								taskResult.status === "failed" || taskResult.status === "blocked"
									? buildFailureSummary(task, taskResult, {
											worktreePath: lastAttemptWorktreePath,
											baseRef: lastAttemptBaseRef,
									  })
									: lastFailureSummary ?? retry.lastFailureSummary,
							lastAttemptBaseRef: lastAttemptBaseRef ?? retry.lastAttemptBaseRef,
							lastAttemptWorktreePath: lastAttemptWorktreePath ?? retry.lastAttemptWorktreePath,
						},
					};
				});
				const applied = applyTaskResult(graphWithRetry, taskResult);
				const history = [...currentState.execution.history];
				if (taskResult.status === "completed") {
					if (resultRunId !== started.runId) {
						history.push(
							createHistoryEntry("task_retry_completed", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }),
						);
						if (retryPatchApplied) {
							history.push(
								createHistoryEntry("task_retry_patch_applied", `Applied retry patch for ${nextTask.id}.`, {
									taskId: nextTask.id,
									runId: resultRunId,
								}),
							);
						}
					}
					history.push(createHistoryEntry("task_completed", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }));
				} else if (taskResult.status === "failed") {
					if (resultRunId !== started.runId) {
						history.push(createHistoryEntry("task_retry_failed", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }));
					}
					history.push(createHistoryEntry("task_failed", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }));
				} else {
					if (resultRunId !== started.runId && (taskResult.status === "blocked" || taskResult.status === "needs_review")) {
						history.push(createHistoryEntry("task_retry_failed", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }));
					}
					history.push(createHistoryEntry("task_blocked", taskResult.summary, { taskId: nextTask.id, runId: resultRunId }));
					if (applied.followUpTaskId) {
						history.push(
							createHistoryEntry("task_followup_created", `Created follow-up ${applied.followUpTaskId}.`, {
								taskId: applied.followUpTaskId,
								runId: resultRunId,
							}),
						);
					}
				}
				return {
					...currentState,
					status: taskResult.status === "failed" ? "failed" : "executing",
					compiledTaskGraph: applied.graph,
					execution: {
						...currentState.execution,
						currentTaskId: undefined,
						currentRunId: undefined,
						runningRunIds: currentState.execution.runningRunIds.filter(
							(runId) => runId !== started.runId && runId !== resultRunId,
						),
						lastError: taskResult.status === "failed" ? taskResult.summary : currentState.execution.lastError,
						history,
					},
				};
			});

			if (taskResult.status === "failed") {
				ctx.ui.notify(`Task ${nextTask.id} failed.`, "error");
				return;
			}
			if (taskResult.status === "blocked" || taskResult.status === "needs_review") {
				ctx.ui.notify(`Task ${nextTask.id} produced a follow-up.`, "info");
			}
		}
	}

	async function approveAndStartExecution(ctx: ExtensionContext) {
		const state = stateManager.getState();
		if (!state.plan) {
			return textResult("No plan is available to approve.", undefined, true);
		}
		const validation = validatePlanDoc(state.plan);
		if (!validation.valid) {
			const message = `Plan is still invalid:\n${buildValidationText(validation)}`;
			ctx.ui.notify(message, "error");
			return textResult(message, { validation }, true);
		}

		let taskGraph: TaskGraph;
		try {
			taskGraph = compilePlanDoc(state.plan);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(message, "error");
			return textResult(message, { validation }, true);
		}

		stateManager.activateExecution(ctx, taskGraph, validation);
		ctx.ui.notify("Plan approved. Execution mode started.", "info");
		ensureExecutionLoop(ctx);
		if (!ctx.hasUI || getAutoApprovePlanConfig().enabled) {
			await executionPromise;
			const finalState = stateManager.getState();
			if (finalState.status === "completed") {
				stateManager.deactivate(ctx);
				return textResult("DONE", { taskGraph: finalState.compiledTaskGraph, validation });
			}
			const message =
				finalState.status === "failed"
					? `Plan approved, but execution failed: ${finalState.execution?.lastError ?? "unknown error"}`
					: `Plan approved, but execution ended in ${finalState.status}.`;
			stateManager.deactivate(ctx);
			return textResult(message, { taskGraph: finalState.compiledTaskGraph, validation }, true);
		}
		return textResult(
			"Plan approved. Execution mode started. The main session must not execute steps manually; use get_task_graph or get_plan for status.",
			{ taskGraph, validation },
		);
	}

	async function preparePlanReview(ctx: ExtensionContext) {
		const state = stateManager.getState();
		if (!state.active || state.mode !== "planning") {
			return textResult("Planning mode is not active.", undefined, true);
		}
		if (!state.plan) {
			return textResult("No plan is available to review.", undefined, true);
		}
		const validation = validatePlanDoc(state.plan);
		const preview = await readPlanPreview(state.planFilePath);
		const review = createReviewState(preview, validation, state.feedback);
		stateManager.mutate(ctx, (currentState) => ({
			...currentState,
			validation,
			review,
		}));
		return textResult(buildReviewText(stateManager.getState(), preview, validation, review.validationSummary), {
			review,
			validation,
		}, !validation.valid);
	}

	async function compileCurrentPlan(ctx: ExtensionContext) {
		const state = stateManager.getState();
		if (!state.plan) {
			return textResult("No plan is available to compile.", undefined, true);
		}
		const validation = validatePlanDoc(state.plan);
		if (!validation.valid) {
			return textResult(`Plan cannot be compiled:\n${buildValidationText(validation)}`, { validation }, true);
		}
		try {
			const taskGraph = compilePlanDoc(state.plan);
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				status: "compiled",
				validation,
				compiledTaskGraph: taskGraph,
				compiledTaskGraphId: `graph-${Date.now().toString(36)}`,
				review: currentState.review
					? {
							...currentState.review,
							preview: currentState.review.preview,
							validationSummary: buildValidationText(validation),
					  }
					: undefined,
			}));
			return textResult("Plan compiled.", { taskGraph, validation });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(message, { validation }, true);
		}
	}

	async function exitPlanningMode(
		ctx: ExtensionContext,
		requestedDecision?: "approve" | "revise" | "reject",
		requestedFeedback?: string,
	) {
		const state = stateManager.getState();
		if (!state.active || state.mode !== "planning") {
			return textResult("Planning mode is not active.", undefined, true);
		}
		if (!state.plan) {
			if (!ctx.hasUI) {
				return textResult("Cannot exit planning mode without a plan in non-interactive mode.", undefined, true);
			}
			const ok = await ctx.ui.confirm("Exit planning mode?", "No plan has been captured yet.");
			if (!ok) {
				return textResult("Planning mode exit cancelled.");
			}
			stateManager.deactivate(ctx);
			ctx.ui.notify("Planning mode disabled.", "info");
			return textResult("Planning mode disabled.");
		}

		const validation = validatePlanDoc(state.plan);
		if (!validation.valid) {
			const message = `Plan is still invalid:\n${buildValidationText(validation)}`;
			ctx.ui.notify(message, "error");
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				validation,
				review: createReviewState(currentState.review?.preview ?? "", validation, currentState.feedback),
			}));
			return textResult(message, { validation }, true);
		}

		const autoApprove = getAutoApprovePlanConfig();
		const preview = await readPlanPreview(state.planFilePath);
		const review = createReviewState(preview, validation, state.feedback);
		stateManager.mutate(ctx, (currentState) => ({
			...currentState,
			validation,
			review,
		}));
		const approval = requestedDecision
			? {
					decision: requestedDecision as PlanApprovalDecision,
					preview,
					feedback: requestedFeedback?.trim() ? requestedFeedback.trim() : undefined,
			  }
			: autoApprove.enabled
				? { decision: "approve" as const, preview }
			: !ctx.hasUI
				? { decision: "approve" as const, preview }
			: await requestPlanApproval(ctx, state, validation);
		if (approval.decision === "approve") {
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				feedback: undefined,
				review: {
					...review,
					pending: false,
					lastDecision: "approve",
				},
			}));
			return approveAndStartExecution(ctx);
		}
		if (approval.decision === "revise" || approval.decision === "reject") {
			const feedback =
				approval.feedback?.trim() ||
				(approval.decision === "reject"
					? "User rejected the current plan artifact."
					: "User requested more planning work.");
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				feedback,
				validation,
					review: {
						...review,
						pending: false,
						feedback,
						lastDecision: approval.decision === "reject" ? "reject" : "revise",
					},
				}));
			return textResult(
				approval.decision === "reject" ? "Plan rejected and kept in planning mode." : "Plan kept in planning mode for revision.",
				{ validation, preview: approval.preview, feedback },
			);
		}
		return textResult(
			ctx.hasUI
				? "Plan approval cancelled."
				: "Plan approval cancelled.",
			{ validation, preview: approval.preview, review },
			!ctx.hasUI,
		);
	}

	pi.registerTool({
		name: "set_plan",
		label: "set_plan",
		description: "Persist the full latest structured plan, validate it, and rewrite the canonical plan file.",
		parameters: SetPlanSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.active || state.mode !== "planning") {
				return textResult("set_plan is only available while planning mode is active.", undefined, true);
			}
			if (!state.planFilePath) {
				return textResult("No active plan file. Restart planning mode and try again.", undefined, true);
			}

			const plan = normalizePlanDoc((params as { plan?: unknown }).plan);
			const validation = validatePlanDoc(plan);
			if (!validation.valid) {
				return textResult(`Plan rejected:\n${buildValidationText(validation)}`, { validation, plan }, true);
			}

			await writePlanFile(state.planFilePath, plan);
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				status: "draft",
				plan,
				planId: `plan-${Date.now().toString(36)}`,
				validation,
				compiledTaskGraph: undefined,
				compiledTaskGraphId: undefined,
				feedback: undefined,
				review: undefined,
				execution: undefined,
			}));
			return textResult("Plan written.", { plan, validation });
		},
	});

	pi.registerTool({
		name: "get_plan",
		label: "get_plan",
		description: "Return the current plan summary and structured state for planning-mode recovery.",
		parameters: Type.Object({}),
		async execute() {
			const state = stateManager.getState();
			return textResult(getPlanSummary(state), { state });
		},
	});

	pi.registerTool({
		name: "request_user_input",
		label: "request_user_input",
		description: "Ask the user focused planning questions with select or input prompts.",
		parameters: RequestUserInputSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.active || state.mode !== "planning") {
				return textResult("request_user_input is only available while planning mode is active.", undefined, true);
			}
			if (!ctx.hasUI) {
				return textResult("request_user_input requires interactive UI.", undefined, true);
			}

			const questions = normalizeUserInputQuestions((params as { questions?: unknown[] }).questions);
			if (questions.length === 0) {
				return textResult("request_user_input requires at least one valid question.", undefined, true);
			}

			const answers: UserInputAnswer[] = [];
			for (const question of questions) {
				if (question.kind === "input") {
					const value = await ctx.ui.input(question.question, question.placeholder ?? "");
					if (value === null || value === undefined) {
						return textResult("User input cancelled.", { answers }, true);
					}
					answers.push({ id: question.id, label: question.label, answer: String(value).trim() });
					continue;
				}
				const choice = await ctx.ui.select(question.question, question.options);
				if (!choice) {
					return textResult("User input cancelled.", { answers }, true);
				}
				answers.push({ id: question.id, label: question.label, answer: String(choice) });
			}

			return textResult(answers.map((answer) => `${answer.label}: ${answer.answer}`).join("\n"), { answers });
		},
	});

	pi.registerTool({
		name: "compile_plan",
		label: "compile_plan",
		description: "Compile the current valid plan into a deterministic task graph.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return compileCurrentPlan(ctx);
		},
	});

	pi.registerTool({
		name: "plan_exit",
		label: "plan_exit",
		description: "Validate the plan, request approval, compile it, and transition into execution mode.",
		parameters: PlanExitSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = normalizePlanApprovalDecision((params as { decision?: unknown }).decision);
			const feedback = typeof (params as { feedback?: unknown }).feedback === "string" ? (params as { feedback?: string }).feedback : undefined;
			return exitPlanningMode(ctx, decision, feedback);
		},
	});

	pi.registerTool({
		name: "get_task_graph",
		label: "get_task_graph",
		description: "Return the current compiled task graph and execution summary.",
		parameters: Type.Object({}),
		async execute() {
			const state = stateManager.getState();
			if (!state.compiledTaskGraph) {
				return textResult("No compiled task graph is available.", undefined, true);
			}
			return textResult(`${summarizeTaskGraph(state.compiledTaskGraph)}\n\n${formatTaskList(state.compiledTaskGraph)}`, {
				taskGraph: state.compiledTaskGraph,
				execution: state.execution,
			});
		},
	});

	pi.registerTool({
		name: "get_runs",
		label: "get_runs",
		description: "Return current known subagent runs for this workspace and their execution bindings.",
		parameters: GetRunsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			const { text, details } = await buildRunsView(state, ctx, workerRuntime);
			const { status, mode, limit } = params as { status?: string; mode?: string; limit?: number };
			const filteredRuns = (details.runs as Array<Record<string, unknown>>).filter((run) => {
				if (status && run.status !== status) {
					return false;
				}
				if (mode && run.mode !== mode) {
					return false;
				}
				return true;
			});
			const limitedRuns = typeof limit === "number" ? filteredRuns.slice(0, limit) : filteredRuns;
			const filteredText =
				limitedRuns.length === 0
					? "No subagent runs found."
					: limitedRuns
							.map((run) =>
								[
									`${run.runId as string} [${run.status as string}]`,
									run.taskId ? `task=${run.taskId as string}` : undefined,
									run.executionMode ? `mode=${run.executionMode as string}` : undefined,
									run.attempt ? `attempt=${String(run.attempt)}` : undefined,
									run.agent ? `agent=${run.agent as string}` : undefined,
								]
									.filter(Boolean)
									.join(" "),
							)
							.join("\n");
			return textResult(filteredText || text, { runs: limitedRuns });
		},
	});

	pi.registerTool({
		name: "get_run_trace",
		label: "get_run_trace",
		description: "Return a persisted summary or raw tail for a specific subagent run trace.",
		parameters: GetRunTraceSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { runId, raw } = params as { runId: string; raw?: boolean };
			return buildRunTraceView(stateManager.getState(), ctx.cwd, runId, raw);
		},
	});

	pi.registerTool({
		name: "get_cell_state",
		label: "get_cell_state",
		description: "Return the current swarm cell state for a task or run when executionMode is swarm.",
		parameters: GetCellStateSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.compiledTaskGraph) {
				return textResult("No compiled task graph is available.", undefined, true);
			}
			const { taskId, runId } = params as { taskId?: string; runId?: string };
			const task =
				(taskId ? state.compiledTaskGraph.tasks.find((candidate) => candidate.id === taskId) : undefined) ??
				(runId ? state.compiledTaskGraph.tasks.find((candidate) => candidate.owner === runId) : undefined);
			if (!task) {
				return textResult("No task matched the requested cell lookup.", undefined, true);
			}
			const resolvedRunId = task.owner ?? runId;
			if (!resolvedRunId) {
				return textResult(`Task ${task.id} has no active run bound to it.`, undefined, true);
			}
			return buildCellStateView(state, task.id, workerRuntime.readCellState(ctx, resolvedRunId));
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "task_update",
		description: "Apply a direct task status update to the current execution graph.",
		parameters: TaskUpdateSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.compiledTaskGraph || state.mode !== "execution") {
				return textResult("task_update is only available during execution.", undefined, true);
			}
			const { taskId, status, owner, notes } = params as {
				taskId: string;
				status?: TaskNode["status"];
				owner?: string;
				notes?: string[];
			};
			let updatedTask: TaskNode | undefined;
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				compiledTaskGraph: currentState.compiledTaskGraph
					? {
							...currentState.compiledTaskGraph,
							tasks: currentState.compiledTaskGraph.tasks.map((task) => {
								if (task.id !== taskId) {
									return task;
								}
								updatedTask = {
									...task,
									status: status ?? task.status,
									owner: owner ?? task.owner,
									notes: notes ? Array.from(new Set([...task.notes, ...notes])) : task.notes,
								};
								return updatedTask;
							}),
					  }
					: currentState.compiledTaskGraph,
			}));
			if (!updatedTask) {
				return textResult(`Unknown task: ${taskId}`, undefined, true);
			}
			return textResult(`Updated task ${taskId}.`, { task: updatedTask });
		},
	});

	pi.registerTool({
		name: "record_task_result",
		label: "record_task_result",
		description: "Apply a structured task result to the current execution graph.",
		parameters: TaskResultSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.compiledTaskGraph || state.mode !== "execution") {
				return textResult("record_task_result is only available during execution.", undefined, true);
			}
			const taskResult = normalizeTaskResult(params);
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				compiledTaskGraph: currentState.compiledTaskGraph
					? applyTaskResult(currentState.compiledTaskGraph, taskResult).graph
					: currentState.compiledTaskGraph,
			}));
			return textResult(`Recorded result for ${taskResult.taskId}.`, { taskResult });
		},
	});

	pi.registerTool({
		name: "pause_execution",
		label: "pause_execution",
		description: "Pause the current execution loop without discarding the compiled task graph.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.execution || state.mode !== "execution") {
				return textResult("Execution is not active.", undefined, true);
			}
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				status: "blocked",
				execution: currentState.execution
					? {
							...currentState.execution,
							paused: true,
							history: [
								...currentState.execution.history,
								createHistoryEntry("execution_paused", "Execution paused."),
							],
					  }
					: currentState.execution,
			}));
			return textResult("Execution paused.");
		},
	});

	pi.registerTool({
		name: "resume_execution",
		label: "resume_execution",
		description: "Resume the execution loop from the current compiled task graph.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = stateManager.getState();
			if (!state.execution || state.mode !== "execution") {
				return textResult("Execution is not active.", undefined, true);
			}
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				status: "executing",
				execution: currentState.execution
					? {
							...currentState.execution,
							paused: false,
							history: [
								...currentState.execution.history,
								createHistoryEntry("execution_resumed", "Execution resumed."),
							],
					  }
					: currentState.execution,
			}));
			ensureExecutionLoop(ctx);
			return textResult("Execution resumed.");
		},
	});

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Enter planning mode or manage the current plan lifecycle.",
		handler: async (args, ctx) => {
			const rawArgs = typeof args === "string" ? args.trim() : "";
			const [subcommand, ...rest] = rawArgs.split(/\s+/).filter(Boolean);
			const state = stateManager.getState();

			if (subcommand === "status") {
				ctx.ui.notify(getPlanSummary(state), "info");
				return;
			}
			if (subcommand === "tasks") {
				if (!state.compiledTaskGraph) {
					ctx.ui.notify("No compiled task graph is available.", "error");
					return;
				}
				ctx.ui.notify(formatTaskList(state.compiledTaskGraph), "info");
				return;
			}
			if (subcommand === "validate") {
				if (!state.plan) {
					ctx.ui.notify("No plan is available to validate.", "error");
					return;
				}
				const validation = validatePlanDoc(state.plan);
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					validation,
				}));
				ctx.ui.notify(buildValidationText(validation), validation.valid ? "info" : "error");
				return;
			}
			if (subcommand === "compile") {
				const result = await compileCurrentPlan(ctx);
				ctx.ui.notify(result.content[0]?.text ?? "Plan compile finished.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "open") {
				ctx.ui.notify(`Plan file: ${state.planFilePath ?? "n/a"}`, "info");
				return;
			}
			if (subcommand === "review") {
				const result = await preparePlanReview(ctx);
				ctx.ui.notify(result.content[0]?.text ?? "Plan review prepared.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "approve") {
				const result = await exitPlanningMode(ctx, "approve");
				ctx.ui.notify(result.content[0]?.text ?? "Plan approved.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "revise") {
				const feedback = rest.join(" ").trim();
				const result = await exitPlanningMode(ctx, "revise", feedback || undefined);
				ctx.ui.notify(result.content[0]?.text ?? "Plan kept in planning mode.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "reject") {
				const feedback = rest.join(" ").trim();
				const result = await exitPlanningMode(ctx, "reject", feedback || undefined);
				ctx.ui.notify(result.content[0]?.text ?? "Plan rejected.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "runs") {
				const { text } = await buildRunsView(state, ctx, workerRuntime);
				ctx.ui.notify(text, "info");
				return;
			}
			if (subcommand === "trace") {
				const runId = rest[0];
				if (!runId) {
					ctx.ui.notify("Usage: /plan trace <runId>", "error");
					return;
				}
				const result = await buildRunTraceView(state, ctx.cwd, runId, rest.includes("--raw"));
				ctx.ui.notify(result.content[0]?.text ?? "Trace loaded.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "cell") {
				const taskId = rest[0];
				if (!taskId) {
					ctx.ui.notify("Usage: /plan cell <taskId>", "error");
					return;
				}
				if (!state.compiledTaskGraph) {
					ctx.ui.notify("No compiled task graph is available.", "error");
					return;
				}
				const task = state.compiledTaskGraph.tasks.find((candidate) => candidate.id === taskId);
				if (!task?.owner) {
					ctx.ui.notify(`Task ${taskId} has no active swarm cell.`, "error");
					return;
				}
				const result = buildCellStateView(state, taskId, workerRuntime.readCellState(ctx, task.owner));
				ctx.ui.notify(result.content[0]?.text ?? "Cell state loaded.", result.isError ? "error" : "info");
				return;
			}
			if (subcommand === "stop") {
				if (state.mode !== "execution" || !state.execution) {
					ctx.ui.notify("Execution mode is not active.", "error");
					return;
				}
				if (state.execution.currentRunId) {
					await workerRuntime.stopRun(ctx, state.execution.currentRunId);
				}
				stateManager.mutate(ctx, (currentState) => ({
					...currentState,
					status: "blocked",
					execution: currentState.execution
						? {
								...currentState.execution,
								paused: true,
								history: [
									...currentState.execution.history,
									createHistoryEntry("execution_paused", "Execution stopped by user."),
								],
						  }
						: currentState.execution,
				}));
				ctx.ui.notify("Execution stopped.", "info");
				return;
			}

			if (state.active && state.mode === "planning") {
				await exitPlanningMode(ctx);
				return;
			}
			if (state.active && state.mode === "execution") {
				ctx.ui.notify(getPlanSummary(state), "info");
				return;
			}

			const rawLocation =
				subcommand &&
				!["status", "tasks", "validate", "compile", "open", "review", "approve", "revise", "reject", "runs", "trace", "cell", "stop"].includes(subcommand)
				? [subcommand, ...rest].join(" ")
				: rawArgs;
			const planFilePath = await resolvePlanFilePath(ctx, rawLocation);
			await initializePlanFile(planFilePath);
			stateManager.enterPlanning(ctx, planFilePath);
			ctx.ui.notify(`Planning mode enabled.\nPlan file: ${planFilePath}`, "info");
		},
	});

	pi.registerShortcut(PLAN_SHORTCUT, {
		description: "Toggle planning mode",
		handler: async (ctx) => {
			const state = stateManager.getState();
			if (state.active && state.mode === "planning") {
				await exitPlanningMode(ctx);
				return;
			}
			if (state.active && state.mode === "execution") {
				ctx.ui.notify(getPlanSummary(state), "info");
				return;
			}
			const planFilePath = await resolvePlanFilePath(ctx, "");
			await initializePlanFile(planFilePath);
			stateManager.enterPlanning(ctx, planFilePath);
			ctx.ui.notify(`Planning mode enabled.\nPlan file: ${planFilePath}`, "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await maybeAutoEnterPlanning(ctx);
		stateManager.syncTools();
		const state = stateManager.getState();
		if (!state.active) {
			return;
		}
		if (state.mode === "execution") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildExecutionPrompt(state)}`,
				message: {
					customType: CONTEXT_ENTRY_TYPE,
					content: getPlanSummary(state),
					display: false,
				},
			};
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanningPrompt(state)}`,
			message: {
				customType: CONTEXT_ENTRY_TYPE,
				content: getPlanSummary(state),
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event) => {
		const state = stateManager.getState();
		if (!state.active) {
			return;
		}
		if (state.mode === "planning") {
			if (!MUTATING_TOOL_NAMES.includes(event.toolName as never)) {
				return;
			}
			return {
				block: true,
				reason: `Planning mode blocks ${event.toolName}. Exit planning mode before making changes.`,
			};
		}
		if (EXECUTION_TOOL_NAMES.includes(event.toolName as never)) {
			return;
		}
		return {
			block: true,
			reason:
				state.status === "completed"
					? "Execution is complete and verification passed. Reply with DONE only."
					: `Execution mode blocks ${event.toolName}. The main session does not execute tasks directly; workers are already running. Use get_task_graph, get_plan, get_runs, get_run_trace, or get_cell_state for status.`,
		};
	});

	const refreshState = (_event: unknown, ctx: ExtensionContext) => {
		stateManager.refresh(ctx);
		ensureExecutionLoop(ctx);
	};

	pi.on("session_start", async (event, ctx) => {
		refreshState(event, ctx);
		await maybeAutoEnterPlanning(ctx);
	});
	(pi as any).on("session_switch", async (event: unknown, ctx: ExtensionContext) => {
		refreshState(event, ctx);
		await maybeAutoEnterPlanning(ctx);
	});
	(pi as any).on("session_tree", async (event: unknown, ctx: ExtensionContext) => {
		refreshState(event, ctx);
		await maybeAutoEnterPlanning(ctx);
	});
	(pi as any).on("session_fork", async (event: unknown, ctx: ExtensionContext) => {
		refreshState(event, ctx);
		await maybeAutoEnterPlanning(ctx);
	});
}
