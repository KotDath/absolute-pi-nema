import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentResult } from "../absolute-subagents/types.js";
import { createSwarmRuntime } from "../absolute-swarm/index.js";
import type { CellTaskResult, RoleRunner, RoleRunResult } from "../absolute-swarm/types.js";
import {
	CONTEXT_ENTRY_TYPE,
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
} from "./executor.js";
import { initializePlanFile, resolvePlanFilePath, writePlanFile } from "./plan-files.js";
import { buildPlanningPrompt } from "./prompt.js";
import { PlanExitSchema, RequestUserInputSchema, SetPlanSchema, TaskResultSchema, TaskUpdateSchema } from "./schemas.js";
import { createPlanStateManager } from "./state.js";
import { readSubagentResult, startBackgroundSubagentRun, stopSubagentRun, waitForSubagentRun } from "./subagent-runtime.js";
import type { PlanApprovalDecision, PlanDoc, PlanModeState, TaskGraph, TaskNode, TaskResult, UserInputAnswer, ValidationResult } from "./types.js";
import { normalizePlanDoc, normalizeTaskResult, normalizeUserInputQuestions, validatePlanDoc } from "./validation.js";

const WORKER_WAIT_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_PREVIEW_LIMIT = 1200;

interface WorkerRuntime {
	startTask(ctx: ExtensionContext, task: TaskNode, graph: TaskGraph, state: PlanModeState): Promise<{ runId: string }>;
	startVerification(ctx: ExtensionContext, graph: TaskGraph, state: PlanModeState): Promise<{ runId: string }>;
	waitForRun(ctx: ExtensionContext, runId: string): Promise<{ state: { status: string } | null; result: AgentResult | null }>;
	stopRun(ctx: ExtensionContext, runId: string): Promise<void>;
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

async function requestPlanApproval(ctx: ExtensionContext, state: PlanModeState): Promise<{ decision: PlanApprovalDecision; preview: string }> {
	const preview = await readPlanPreview(state.planFilePath);
	if (!ctx.hasUI) {
		return { decision: "cancel", preview };
	}
	const prompt = [`Plan file: ${state.planFilePath ?? "n/a"}`, "", preview].join("\n");
	const choice = await ctx.ui.select(prompt, [READY_APPROVAL_OPTION, REVISE_APPROVAL_OPTION, REJECT_APPROVAL_OPTION]);
	if (choice === READY_APPROVAL_OPTION) {
		return { decision: "approve", preview };
	}
	if (choice === REVISE_APPROVAL_OPTION) {
		return { decision: "revise", preview };
	}
	if (choice === REJECT_APPROVAL_OPTION) {
		return { decision: "reject", preview };
	}
	return { decision: "cancel", preview };
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

function parseTaskResultFromAgentResult(task: TaskNode, result: AgentResult | null, fallbackStatus?: string): TaskResult {
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

function buildWorkerTaskPrompt(task: TaskNode, graph: TaskGraph, state: PlanModeState): string {
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
		"Return exactly one JSON object with this shape:",
		'{"taskId":"...", "status":"completed|blocked|failed|needs_review", "summary":"...", "changedFiles":["..."], "validationsRun":["..."], "artifacts":["..."], "blockers":["..."], "notes":["..."]}',
		"",
		"Requirements:",
		"- Use the provided taskId.",
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
		"Only return completed if the overall plan verification has passed.",
	].join("\n");
}

function createDefaultWorkerRuntime(): WorkerRuntime {
	const roleRunnerFactory = (ctx: ExtensionContext): RoleRunner => ({
		async startRole(role, prompt) {
			const started = await startBackgroundSubagentRun(ctx.cwd, {
				agent: role === "implementer" ? "worker" : role,
				task: prompt,
				mode: "background",
			});
			return { runId: started.runId };
		},
		async waitForRun(runId) {
			const waited = await waitForSubagentRun(ctx.cwd, runId, { timeoutMs: WORKER_WAIT_TIMEOUT_MS });
			const result = waited.result ?? readSubagentResult(ctx.cwd, runId);
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
			stopSubagentRun(ctx.cwd, runId);
		},
	});

	const swarmRuntimeByCwd = new Map<string, ReturnType<typeof createSwarmRuntime>>();
	const getSwarmRuntime = (ctx: ExtensionContext) => {
		let runtime = swarmRuntimeByCwd.get(ctx.cwd);
		if (!runtime) {
			runtime = createSwarmRuntime({ roleRunner: roleRunnerFactory(ctx) });
			swarmRuntimeByCwd.set(ctx.cwd, runtime);
		}
		return runtime;
	};

	return {
		async startTask(ctx, task, graph, state) {
			if (task.executionMode === "swarm") {
				const runtime = getSwarmRuntime(ctx);
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
				});
				void runtime.runCell(cell.id);
				return { runId: cell.id };
			}
			const prompt = buildWorkerTaskPrompt(task, graph, state);
			const started = await startBackgroundSubagentRun(ctx.cwd, {
				agent: "worker",
				task: prompt,
				mode: "background",
			});
			return { runId: started.runId };
		},
		async waitForRun(ctx, runId) {
			const runtime = getSwarmRuntime(ctx);
			if (runtime.hasCell(runId)) {
				const cell = await runtime.runCell(runId);
				const result = runtime.collectCellResult(runId);
				return {
					state: { status: cell.status === "failed" ? "failed" : cell.status === "blocked" ? "stopped" : "completed" },
					result: result ? createSyntheticAgentResult(runId, result) : null,
				};
			}
			return waitForSubagentRun(ctx.cwd, runId, { timeoutMs: WORKER_WAIT_TIMEOUT_MS });
		},
		async startVerification(ctx, graph, state) {
			const started = await startBackgroundSubagentRun(ctx.cwd, {
				agent: "verifier",
				task: buildVerificationPrompt(graph, state),
				mode: "background",
			});
			return { runId: started.runId };
		},
		async stopRun(ctx, runId) {
			const runtime = getSwarmRuntime(ctx);
			if (runtime.hasCell(runId)) {
				await runtime.stopCell(runId);
				return;
			}
			stopSubagentRun(ctx.cwd, runId);
		},
	};
}

function buildValidationText(validation: ValidationResult): string {
	if (validation.valid && validation.warnings.length === 0) {
		return "Plan is valid.";
	}
	return formatValidation(validation);
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
		executionPromise = runExecutionLoop(ctx).finally(() => {
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
			},
			waited.result ?? readSubagentResult(ctx.cwd, started.runId),
			waited.state?.status,
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
					? startTask(claimTask(currentState.compiledTaskGraph, nextTask.id, started.runId), nextTask.id, started.runId)
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
			const taskResult = parseTaskResultFromAgentResult(nextTask, agentResult, waited.state?.status);

			stateManager.mutate(ctx, (currentState) => {
				if (!currentState.compiledTaskGraph || !currentState.execution) {
					return currentState;
				}
				const applied = applyTaskResult(currentState.compiledTaskGraph, taskResult);
				const history = [...currentState.execution.history];
				if (taskResult.status === "completed") {
					history.push(createHistoryEntry("task_completed", taskResult.summary, { taskId: nextTask.id, runId: started.runId }));
				} else if (taskResult.status === "failed") {
					history.push(createHistoryEntry("task_failed", taskResult.summary, { taskId: nextTask.id, runId: started.runId }));
				} else {
					history.push(createHistoryEntry("task_blocked", taskResult.summary, { taskId: nextTask.id, runId: started.runId }));
					if (applied.followUpTaskId) {
						history.push(
							createHistoryEntry("task_followup_created", `Created follow-up ${applied.followUpTaskId}.`, {
								taskId: applied.followUpTaskId,
								runId: started.runId,
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
						runningRunIds: currentState.execution.runningRunIds.filter((runId) => runId !== started.runId),
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
		return textResult("Plan approved. Execution mode started.", { taskGraph, validation });
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
			}));
			return textResult("Plan compiled.", { taskGraph, validation });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(message, { validation }, true);
		}
	}

	async function exitPlanningMode(ctx: ExtensionContext, requestedDecision?: "approve" | "revise" | "reject") {
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
			return textResult(message, { validation }, true);
		}

		const approval = requestedDecision
			? { decision: requestedDecision as PlanApprovalDecision, preview: await readPlanPreview(state.planFilePath) }
			: await requestPlanApproval(ctx, state);
		if (approval.decision === "approve") {
			return approveAndStartExecution(ctx);
		}
		if (approval.decision === "revise" || approval.decision === "reject") {
			const feedback = approval.decision === "reject" ? "User rejected the current plan artifact." : "User requested more planning work.";
			stateManager.mutate(ctx, (currentState) => ({
				...currentState,
				feedback,
				validation,
			}));
			return textResult(
				approval.decision === "reject" ? "Plan rejected and kept in planning mode." : "Plan kept in planning mode for revision.",
				{ validation, preview: approval.preview, feedback },
			);
		}
		return textResult("Plan approval cancelled.", { validation, preview: approval.preview });
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
			const decision = (params as { decision?: "approve" | "revise" | "reject" }).decision;
			return exitPlanningMode(ctx, decision);
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

			const rawLocation = subcommand && !["status", "tasks", "validate", "compile", "open", "stop"].includes(subcommand)
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

	pi.on("before_agent_start", async (event) => {
		stateManager.syncTools();
		const state = stateManager.getState();
		if (!state.active || state.mode !== "planning") {
			return;
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
		if (!state.active || state.mode !== "planning") {
			return;
		}
		if (!MUTATING_TOOL_NAMES.includes(event.toolName as never)) {
			return;
		}
		return {
			block: true,
			reason: `Planning mode blocks ${event.toolName}. Exit planning mode before making changes.`,
		};
	});

	const refreshState = (_event: unknown, ctx: ExtensionContext) => {
		stateManager.refresh(ctx);
		ensureExecutionLoop(ctx);
	};

	pi.on("session_start", refreshState);
	(pi as any).on("session_switch", refreshState);
	(pi as any).on("session_tree", refreshState);
	(pi as any).on("session_fork", refreshState);
}
