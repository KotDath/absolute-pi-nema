import { resolve } from "node:path";
import { DEFAULT_WAIT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS } from "../absolute-subagents/constants.js";
import { appendJsonl, writeJson } from "../absolute-subagents/fs.js";
import { createMessageId, createRunId } from "../absolute-subagents/ids.js";
import {
	resolveConfigPath,
	resolveEventsPath,
	resolveInboxPath,
	resolveResultPath,
	resolveRunDir,
	resolveSessionDir,
	resolveStatePath,
	resolveStderrPath,
	resolveTracePath,
} from "../absolute-subagents/paths.js";
import { resolveAgentProfile } from "../absolute-subagents/profiles.js";
import { enqueueMessage } from "../absolute-subagents/queue.js";
import { spawnBackgroundRunner } from "../absolute-subagents/background.js";
import { ensureRunPaths, readRunResult, readRunState, writeRunState } from "../absolute-subagents/state.js";
import type { AgentResult, AgentRunConfig, AgentRunState, SpawnAgentInput } from "../absolute-subagents/types.js";

export interface StartedSubagentRun {
	runId: string;
	state: AgentRunState;
}

function resolveCwd(baseCwd: string, requestedCwd: string | undefined): string {
	if (!requestedCwd?.trim()) {
		return baseCwd;
	}
	return resolve(baseCwd, requestedCwd);
}

function createRunConfig(baseCwd: string, input: SpawnAgentInput): { config: AgentRunConfig; state: AgentRunState } {
	const runId = createRunId();
	const cwd = resolveCwd(baseCwd, input.cwd);
	const runDir = resolveRunDir(cwd, runId);
	const profile = resolveAgentProfile(input.agent, input.systemPrompt);
	const sessionDir = resolveSessionDir(runDir);
	const statePath = resolveStatePath(runDir);
	const resultPath = resolveResultPath(runDir);
	const inboxPath = resolveInboxPath(runDir);
	const eventsPath = resolveEventsPath(runDir);
	const tracePath = resolveTracePath(runDir);
	const stderrPath = resolveStderrPath(runDir);
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
		tracePath,
		stderrPath,
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
		mode: "background",
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
		tracePath,
		stderrPath,
	};

	return { config, state };
}

export async function startBackgroundSubagentRun(baseCwd: string, input: SpawnAgentInput): Promise<StartedSubagentRun> {
	const { config, state } = createRunConfig(baseCwd, { ...input, mode: "background" });
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
	writeRunState(config.statePath, state);
	const pid = spawnBackgroundRunner(config.configPath, config.cwd);
	const queuedState: AgentRunState = {
		...state,
		pid,
		updatedAt: Date.now(),
	};
	writeRunState(config.statePath, queuedState);
	return {
		runId: config.id,
		state: queuedState,
	};
}

export async function waitForSubagentRun(baseCwd: string, runId: string, options?: { timeoutMs?: number; pollIntervalMs?: number }) {
	const statePath = resolveStatePath(resolveRunDir(baseCwd, runId));
	const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() <= deadline) {
		const state = readRunState(statePath);
		if (!state) {
			return { state: null, result: null };
		}
		if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
			return { state, result: readRunResult(state.resultPath) };
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
	}

	const state = readRunState(statePath);
	return {
		state,
		result: state ? readRunResult(state.resultPath) : null,
	};
}

export function readSubagentResult(baseCwd: string, runId: string): AgentResult | null {
	return readRunResult(resolveResultPath(resolveRunDir(baseCwd, runId)));
}

export function stopSubagentRun(baseCwd: string, runId: string): AgentRunState | null {
	const statePath = resolveStatePath(resolveRunDir(baseCwd, runId));
	const state = readRunState(statePath);
	if (!state) {
		return null;
	}
	if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
		return state;
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
	return nextState;
}
