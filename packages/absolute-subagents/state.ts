import fs from "node:fs";
import path from "node:path";
import { SUBAGENT_ENTRY_TYPE } from "./constants.js";
import { readJson, writeJson } from "./fs.js";
import { resolveRunsDir, resolveRunDir, resolveStatePath } from "./paths.js";
import type { AgentResult, AgentRunSnapshot, AgentRunState } from "./types.js";

export function writeRunState(statePath: string, state: AgentRunState): void {
	writeJson(statePath, state);
}

export function readRunState(statePath: string): AgentRunState | null {
	return readJson<AgentRunState>(statePath);
}

export function writeRunResult(resultPath: string, result: AgentResult): void {
	writeJson(resultPath, result);
}

export function readRunResult(resultPath: string): AgentResult | null {
	return readJson<AgentResult>(resultPath);
}

export function listRunStates(cwd: string): AgentRunState[] {
	const runsDir = resolveRunsDir(cwd);
	try {
		return fs
			.readdirSync(runsDir)
			.map((entry) => resolveStatePath(resolveRunDir(cwd, entry)))
			.map((statePath) => readRunState(statePath))
			.filter((state): state is AgentRunState => Boolean(state))
			.sort((left, right) => right.updatedAt - left.updatedAt);
	} catch {
		return [];
	}
}

export function appendRunSnapshot(pi: { appendEntry: (type: string, data: unknown) => void }, state: AgentRunState): void {
	const snapshot: AgentRunSnapshot = {
		runId: state.id,
		status: state.status,
		mode: state.mode,
		agent: state.agent,
		updatedAt: state.updatedAt,
		resultPath: state.resultPath,
	};
	pi.appendEntry(SUBAGENT_ENTRY_TYPE, snapshot);
}

export function ensureRunPaths(runDir: string): void {
	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(path.join(runDir, "session"), { recursive: true });
}

