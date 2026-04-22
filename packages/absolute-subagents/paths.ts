import path from "node:path";
import { RUNTIME_DIR_NAME, RUNS_DIR_NAME } from "./constants.js";

export function resolveRuntimeDir(cwd: string): string {
	return path.join(cwd, RUNTIME_DIR_NAME);
}

export function resolveRunsDir(cwd: string): string {
	return path.join(resolveRuntimeDir(cwd), RUNS_DIR_NAME);
}

export function resolveRunDir(cwd: string, runId: string): string {
	return path.join(resolveRunsDir(cwd), runId);
}

export function resolveStatePath(runDir: string): string {
	return path.join(runDir, "state.json");
}

export function resolveResultPath(runDir: string): string {
	return path.join(runDir, "result.json");
}

export function resolveInboxPath(runDir: string): string {
	return path.join(runDir, "inbox.jsonl");
}

export function resolveEventsPath(runDir: string): string {
	return path.join(runDir, "events.jsonl");
}

export function resolveConfigPath(runDir: string): string {
	return path.join(runDir, "config.json");
}

export function resolveSessionDir(runDir: string): string {
	return path.join(runDir, "session");
}

