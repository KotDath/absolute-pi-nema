import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAgentTurn } from "./execution.js";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function createMockProcess(stdoutLines: string[], exitCode: number, stderr = "") {
	const stdout = new EventEmitter();
	const stderrStream = new EventEmitter();
	const child = new EventEmitter() as any;
	child.stdout = stdout;
	child.stderr = stderrStream;
	setTimeout(() => {
		for (const line of stdoutLines) {
			stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
		}
		if (stderr) {
			stderrStream.emit("data", Buffer.from(stderr, "utf8"));
		}
		child.emit("close", exitCode);
	}, 0);
	return child;
}

afterEach(() => {
	vi.restoreAllMocks();
	spawnMock.mockReset();
});

describe("absolute-subagents execution", () => {
	it("parses assistant JSON mode output", async () => {
		spawnMock.mockReturnValue(
			createMockProcess([
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						stopReason: "endTurn",
					},
				}),
			], 0),
		);

		const result = await executeAgentTurn({
			runId: "run-1",
			messageId: "msg-1",
			prompt: "Task",
			cwd: process.cwd(),
			sessionDir: process.cwd(),
		});

		expect(result.exitCode).toBe(0);
		expect(result.finalText).toBe("done");
		expect(result.usage.turns).toBe(1);
	});
});
