import crypto from "node:crypto";

export function createRunId(): string {
	return `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export function createMessageId(runId: string): string {
	return `msg-${runId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

