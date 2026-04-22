import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countPendingMessages, enqueueMessage, readInbox } from "./queue.js";

const tempDirs: string[] = [];

async function createTempDir() {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "absolute-subagents-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("absolute-subagents queue", () => {
	it("appends and reads queued messages", async () => {
		const tempDir = await createTempDir();
		const inboxPath = path.join(tempDir, "inbox.jsonl");

		enqueueMessage(inboxPath, { id: "msg-1", runId: "run-1", role: "user", content: "hello", createdAt: 1 });
		enqueueMessage(inboxPath, { id: "msg-2", runId: "run-1", role: "user", content: "world", createdAt: 2 });

		expect(readInbox(inboxPath)).toHaveLength(2);
		expect(countPendingMessages(inboxPath, 1)).toBe(1);
	});
});

