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
	child.kill = vi.fn((signal?: string) => {
		if (signal === "SIGTERM" || signal === "SIGKILL") {
			child.emit("close", 1);
		}
		return true;
	});
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

	it("treats assistant error responses as failed even with zero exit code", async () => {
		spawnMock.mockReturnValue(
			createMockProcess([
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "Connection error.",
					},
				}),
			], 0),
		);

		const result = await executeAgentTurn({
			runId: "run-2",
			messageId: "msg-2",
			prompt: "Task",
			cwd: process.cwd(),
			sessionDir: process.cwd(),
		});

	expect(result.exitCode).toBe(1);
	expect(result.finalText).toBe("");
		expect(result.error).toBe("Connection error.");
	});

	it("recovers final text from assistant partial updates when the turn exits early", async () => {
		spawnMock.mockReturnValue(
			createMockProcess(
				[
					JSON.stringify({
						type: "message_update",
						assistantMessageEvent: {
							partial: {
								role: "assistant",
								content: [{ type: "text", text: "{\"taskId\":\"1\",\"status\":\"completed\",\"summary\":\"ok\",\"changedFiles\":[],\"validationsRun\":[],\"artifacts\":[],\"blockers\":[],\"notes\":[]}" }],
							},
						},
					}),
				],
				1,
			),
		);

		const result = await executeAgentTurn({
			runId: "run-3",
			messageId: "msg-3",
			prompt: "Task",
			cwd: process.cwd(),
			sessionDir: process.cwd(),
		});

		expect(result.exitCode).toBe(1);
		expect(result.finalText).toContain("\"taskId\":\"1\"");
	});

	it("fails a hung subagent turn after timeout", async () => {
		vi.useFakeTimers();
		const stdout = new EventEmitter();
		const stderrStream = new EventEmitter();
		const child = new EventEmitter() as any;
		child.stdout = stdout;
		child.stderr = stderrStream;
		child.kill = vi.fn((signal?: string) => {
			if (signal === "SIGTERM") {
				child.emit("close", 1);
			}
			return true;
		});
		spawnMock.mockReturnValue(child);

		const resultPromise = executeAgentTurn({
			runId: "run-timeout",
			messageId: "msg-timeout",
			prompt: "Task",
			cwd: process.cwd(),
			sessionDir: process.cwd(),
			timeoutMs: 50,
		});

		await vi.advanceTimersByTimeAsync(75);
		const result = await resultPromise;
		expect(result.exitCode).toBe(1);
		expect(result.error).toBe("Subagent turn timed out after 50ms.");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		vi.useRealTimers();
	});

	it("fails a subagent turn that goes idle after partial output", async () => {
		vi.useFakeTimers();
		const stdout = new EventEmitter();
		const stderrStream = new EventEmitter();
		const child = new EventEmitter() as any;
		child.stdout = stdout;
		child.stderr = stderrStream;
		child.kill = vi.fn((signal?: string) => {
			if (signal === "SIGTERM") {
				child.emit("close", 1);
			}
			return true;
		});
		spawnMock.mockReturnValue(child);

		const resultPromise = executeAgentTurn({
			runId: "run-idle",
			messageId: "msg-idle",
			prompt: "Task",
			cwd: process.cwd(),
			sessionDir: process.cwd(),
			timeoutMs: 500,
			idleTimeoutMs: 50,
		});

		stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						partial: {
							role: "assistant",
							content: [{ type: "text", text: "partial" }],
						},
					},
				})}\n`,
				"utf8",
			),
		);
		await vi.advanceTimersByTimeAsync(75);
		const result = await resultPromise;
		expect(result.exitCode).toBe(1);
		expect(result.finalText).toBe("partial");
		expect(result.error).toBe("Subagent turn became idle after 50ms without output.");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		vi.useRealTimers();
	});
});
