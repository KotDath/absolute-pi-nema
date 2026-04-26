import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ListAgentsSchema, SendAgentMessageSchema, SpawnAgentSchema, StopAgentSchema, WaitAgentSchema } from "./schemas.js";
import { DEFAULT_WAIT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS, SUBAGENT_EVENT_PREFIX } from "./constants.js";
import { spawnBackgroundRunner } from "./background.js";
import { executeAgentTurn } from "./execution.js";
import { appendRunSnapshot, ensureRunPaths, listRunStates, readRunResult, readRunState, writeRunResult, writeRunState } from "./state.js";
import { createMessageId, createRunId } from "./ids.js";
import { resolveConfigPath, resolveEventsPath, resolveInboxPath, resolveResultPath, resolveRunDir, resolveSessionDir, resolveStatePath } from "./paths.js";
import type { AgentResult, AgentRunConfig, AgentRunState, AgentRunStatus, SpawnAgentInput } from "./types.js";
import { resolveAgentProfile } from "./profiles.js";
import { enqueueMessage, countPendingMessages } from "./queue.js";
import { appendJsonl, writeJson } from "./fs.js";

function textResult(text: string, details?: Record<string, unknown>, isError?: boolean) {
	return {
		isError,
		content: [{ type: "text" as const, text }],
		details: details ?? {},
	};
}

function emitExtensionEvent(pi: ExtensionAPI, name: string, payload: Record<string, unknown>) {
	pi.events.emit(`${SUBAGENT_EVENT_PREFIX}:${name}`, payload);
}

function resolveCwd(ctx: ExtensionContext, requestedCwd: string | undefined): string {
	if (!requestedCwd?.trim()) {
		return ctx.cwd;
	}
	return resolve(ctx.cwd, requestedCwd);
}

function createRunConfig(input: SpawnAgentInput, ctx: ExtensionContext): { config: AgentRunConfig; state: AgentRunState } {
	const runId = createRunId();
	const cwd = resolveCwd(ctx, input.cwd);
	const runDir = resolveRunDir(cwd, runId);
	const profile = resolveAgentProfile(input.agent, input.systemPrompt);
	const sessionDir = resolveSessionDir(runDir);
	const statePath = resolveStatePath(runDir);
	const resultPath = resolveResultPath(runDir);
	const inboxPath = resolveInboxPath(runDir);
	const eventsPath = resolveEventsPath(runDir);
	const configPath = resolveConfigPath(runDir);

	const config: AgentRunConfig = {
		id: runId,
		agent: profile.name,
		task: input.task,
		cwd,
		runDir,
		sessionDir,
		configPath,
		statePath,
		resultPath,
		inboxPath,
		eventsPath,
		model: input.model,
		tools: input.tools,
		systemPrompt: profile.systemPrompt,
		timeoutMs: input.timeoutMs,
		idleTimeoutMs: input.idleTimeoutMs,
	};

	const now = Date.now();
	const state: AgentRunState = {
		id: runId,
		agent: profile.name,
		mode: input.mode ?? "foreground",
		status: "queued",
		task: input.task,
		cwd,
		createdAt: now,
		updatedAt: now,
		stopRequested: false,
		nextMessageIndex: 0,
		sessionDir,
		configPath,
		resultPath,
		inboxPath,
		eventsPath,
	};

	return { config, state };
}

function serializeRunSummary(state: AgentRunState, result: AgentResult | null) {
	return {
		runId: state.id,
		agent: state.agent,
		mode: state.mode,
		status: state.status,
		task: state.task,
		cwd: state.cwd,
		pid: state.pid,
		updatedAt: state.updatedAt,
		finalText: result?.finalText ?? "",
		error: result?.error ?? state.lastError,
	};
}

async function waitForRunCompletion(
	statePath: string,
	options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<AgentRunState | null> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const state = readRunState(statePath);
		if (!state) {
			return null;
		}
		if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
			return state;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
	}
	return readRunState(statePath);
}

export default function absoluteSubagentsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "spawn_agent",
		label: "spawn_agent",
		description: "Spawn a foreground or background subagent run with an isolated session directory.",
		parameters: SpawnAgentSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as SpawnAgentInput;
			const { config, state } = createRunConfig(input, ctx);
			ensureRunPaths(config.runDir);
			writeJson(config.configPath, config);
			enqueueMessage(config.inboxPath, {
				id: createMessageId(config.id),
				runId: config.id,
				role: "user",
				content: config.task,
				createdAt: Date.now(),
			});
			appendJsonl(config.eventsPath, { type: "run.created", ts: Date.now(), runId: config.id, mode: state.mode });

			if (state.mode === "foreground") {
				const prompt = config.task;
				const startedAt = Date.now();
				const runningState: AgentRunState = {
					...state,
					status: "running",
					startedAt,
					updatedAt: startedAt,
				};
				writeRunState(config.statePath, runningState);
				appendRunSnapshot(pi, runningState);

				const turn = await executeAgentTurn({
					runId: config.id,
					messageId: createMessageId(config.id),
					prompt,
					cwd: config.cwd,
					sessionDir: config.sessionDir,
					model: config.model,
					tools: config.tools,
					systemPrompt: config.systemPrompt,
					timeoutMs: config.timeoutMs,
					idleTimeoutMs: config.idleTimeoutMs,
				});
				const endedAt = Date.now();
				const status: AgentRunStatus = turn.exitCode === 0 ? "completed" : "failed";
				const result: AgentResult = {
					id: config.id,
					agent: config.agent,
					mode: "foreground",
					status,
					sessionDir: config.sessionDir,
					turns: [
						{
							messageId: createMessageId(config.id),
							prompt,
							exitCode: turn.exitCode,
							finalText: turn.finalText,
							startedAt,
							endedAt,
							stopReason: turn.stopReason,
							error: turn.error,
							messages: turn.messages,
							usage: turn.usage,
						},
					],
					finalText: turn.finalText,
					usage: turn.usage,
					error: turn.error,
				};
				const completedState: AgentRunState = {
					...runningState,
					status,
					endedAt,
					updatedAt: endedAt,
					nextMessageIndex: 1,
					lastError: turn.error,
				};
				writeRunResult(config.resultPath, result);
				writeRunState(config.statePath, completedState);
				appendRunSnapshot(pi, completedState);
				emitExtensionEvent(pi, status === "completed" ? "completed" : "failed", serializeRunSummary(completedState, result));
				return textResult(status === "completed" ? "Foreground subagent completed." : "Foreground subagent failed.", {
					runId: config.id,
					state: completedState,
					result,
				}, status !== "completed");
			}

			writeRunState(config.statePath, state);
			const pid = spawnBackgroundRunner(config.configPath, config.cwd);
			const queuedState: AgentRunState = {
				...state,
				pid,
				updatedAt: Date.now(),
			};
			writeRunState(config.statePath, queuedState);
			appendRunSnapshot(pi, queuedState);
			emitExtensionEvent(pi, "started", serializeRunSummary(queuedState, null));
			return textResult("Background subagent started.", {
				runId: config.id,
				state: queuedState,
			});
		},
	});

	pi.registerTool({
		name: "send_agent_message",
		label: "send_agent_message",
		description: "Queue a follow-up message for a background subagent run and resume it when needed.",
		parameters: SendAgentMessageSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { runId, message } = params as { runId: string; message: string };
			const runDir = resolveRunDir(ctx.cwd, runId);
			const statePath = resolveStatePath(runDir);
			const state = readRunState(statePath);
			if (!state) {
				return textResult(`Unknown run: ${runId}`, undefined, true);
			}
			if (state.mode !== "background") {
				return textResult("send_agent_message is only supported for background runs.", undefined, true);
			}
			if (state.status === "stopped") {
				return textResult("Stopped runs cannot be resumed.", undefined, true);
			}
			if (state.status === "failed") {
				return textResult("Failed runs cannot be resumed via send_agent_message.", undefined, true);
			}

			enqueueMessage(state.inboxPath, {
				id: createMessageId(runId),
				runId,
				role: "user",
				content: message.trim(),
				createdAt: Date.now(),
			});
			const resumedState = readRunState(statePath) ?? state;
			const shouldResume = resumedState.status === "completed";
			let nextState = {
				...resumedState,
				status: shouldResume ? ("queued" as const) : resumedState.status,
				updatedAt: Date.now(),
			};
			if (shouldResume) {
				const pid = spawnBackgroundRunner(resumedState.configPath, resumedState.cwd);
				nextState = {
					...nextState,
					pid,
				};
			}
			writeRunState(statePath, nextState);
			appendRunSnapshot(pi, nextState);
			emitExtensionEvent(pi, shouldResume ? "started" : "updated", serializeRunSummary(nextState, readRunResult(nextState.resultPath)));
			return textResult(shouldResume ? "Message queued and background run resumed." : "Message queued.", {
				runId,
				state: nextState,
				pendingMessages: countPendingMessages(nextState.inboxPath, nextState.nextMessageIndex),
			});
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "wait_agent",
		description: "Wait until a subagent run reaches a terminal state or the timeout expires.",
		parameters: WaitAgentSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { runId, timeoutMs, pollIntervalMs } = params as {
				runId: string;
				timeoutMs?: number;
				pollIntervalMs?: number;
			};
			const state = await waitForRunCompletion(resolveStatePath(resolveRunDir(ctx.cwd, runId)), {
				timeoutMs,
				pollIntervalMs,
			});
			if (!state) {
				return textResult(`Unknown run: ${runId}`, undefined, true);
			}
			const result = readRunResult(state.resultPath);
			return textResult(
				state.status === "running" || state.status === "queued"
					? "Wait timed out before the run finished."
					: `Run ${state.status}.`,
				{ state, result },
				state.status === "failed",
			);
		},
	});

	pi.registerTool({
		name: "stop_agent",
		label: "stop_agent",
		description: "Request stop for a running background subagent and terminate its runner process when possible.",
		parameters: StopAgentSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { runId } = params as { runId: string };
			const statePath = resolveStatePath(resolveRunDir(ctx.cwd, runId));
			const state = readRunState(statePath);
			if (!state) {
				return textResult(`Unknown run: ${runId}`, undefined, true);
			}
			if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
				return textResult(`Run is already ${state.status}.`, { state });
			}

			const nextState: AgentRunState = {
				...state,
				status: "stopped",
				stopRequested: true,
				endedAt: Date.now(),
				updatedAt: Date.now(),
			};
			writeRunState(statePath, nextState);
			if (state.pid) {
				try {
					process.kill(state.pid, "SIGTERM");
				} catch {
					// Process may have already exited.
				}
			}
			appendRunSnapshot(pi, nextState);
			emitExtensionEvent(pi, "stopped", serializeRunSummary(nextState, readRunResult(nextState.resultPath)));
			return textResult("Stop requested.", { state: nextState });
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "list_agents",
		description: "List known subagent runs for the current workspace with optional status/mode filters.",
		parameters: ListAgentsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { status, mode, limit } = params as { status?: AgentRunStatus; mode?: "foreground" | "background"; limit?: number };
			const states = listRunStates(ctx.cwd)
				.filter((state) => (status ? state.status === status : true))
				.filter((state) => (mode ? state.mode === mode : true))
				.slice(0, limit ?? 50);
			return textResult(
				states.length === 0
					? "No subagent runs found."
					: states.map((state) => `${state.id} ${state.agent} ${state.mode} ${state.status}`).join("\n"),
				{
					runs: states.map((state) => serializeRunSummary(state, readRunResult(state.resultPath))),
				},
			);
		},
	});
}
