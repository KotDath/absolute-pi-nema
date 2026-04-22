import { appendJsonl, readJsonl } from "./fs.js";
import type { AgentMessageEnvelope } from "./types.js";

export function enqueueMessage(inboxPath: string, envelope: AgentMessageEnvelope): void {
	appendJsonl(inboxPath, envelope);
}

export function readInbox(inboxPath: string): AgentMessageEnvelope[] {
	return readJsonl<AgentMessageEnvelope>(inboxPath);
}

export function countPendingMessages(inboxPath: string, nextMessageIndex: number): number {
	return Math.max(0, readInbox(inboxPath).length - nextMessageIndex);
}

