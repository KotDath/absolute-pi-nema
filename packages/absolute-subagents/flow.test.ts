import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import absoluteSubagentsExtension from "./index.js";
import { createExtensionHarness } from "./test-harness.js";
import { readRunResult, readRunState } from "./state.js";
import { resolveRunDir, resolveStatePath } from "./paths.js";

const tempDirs: string[] = [];
let previousScript: string | undefined;

async function createTempDir() {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "absolute-subagents-flow-"));
	tempDirs.push(dir);
	return dir;
}

async function createFakePiScript(tempDir: string) {
	const scriptPath = path.join(tempDir, "fake-pi.mjs");
	await fs.promises.writeFile(
		scriptPath,
		`import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : null;
if (sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "session.jsonl"), "");
}
const taskArg = args.find((arg) => arg.startsWith("Task: ")) ?? "Task: unknown";
const task = taskArg.slice(6);
if (task.includes("hang forever")) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (task.includes("hang after token")) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } } }));
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const text = task.includes("follow-up")
  ? "follow-up done"
  : task.includes("provider error")
    ? null
  : task.includes("report env")
    ? \`env:\${process.env.ABSOLUTE_PLAN_AUTOENTER ?? "unset"}:\${process.env.ABSOLUTE_PLAN_AUTOENTER_PATH ?? "unset"}\`
    : task.includes("sleep")
      ? "sleep done"
      : "initial done";
if (text === null) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } }));
  process.exit(0);
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "endTurn" } }));
if (task.includes("sleep")) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
`,
		"utf8",
	);
	return scriptPath;
}

beforeEach(() => {
	previousScript = process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT;
	process.env.ABSOLUTE_SUBAGENTS_RUNNER_DETACHED = "0";
});

afterEach(async () => {
	if (previousScript === undefined) {
		delete process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT;
	} else {
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = previousScript;
	}
	delete process.env.ABSOLUTE_SUBAGENTS_RUNNER_DETACHED;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("absolute-subagents flow", () => {
	it("runs a foreground subagent and persists result", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const result = await harness.tools.get("spawn_agent").execute(
			"tool-1",
			{ task: "initial task", mode: "foreground" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.result.finalText).toBe("initial done");
		expect(harness.emittedEvents.some((event) => event.name === "absolute-subagents:completed")).toBe(true);
	});

	it("processes queued background messages and can resume from completion", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const background = await harness.tools.get("spawn_agent").execute(
			"tool-1",
			{ task: "initial task", mode: "background" },
			undefined,
			undefined,
			harness.ctx,
		);
		const runId = background.details.runId as string;
		const runDir = resolveRunDir(tempDir, runId);
		await harness.tools.get("wait_agent").execute(
			"tool-wait-1",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		let state = readRunState(resolveStatePath(runDir));
		expect(state?.status).toBe("completed");
		expect(readRunResult(path.join(runDir, "result.json"))?.finalText).toBe("initial done");

		const resumed = await harness.tools.get("send_agent_message").execute(
			"tool-2",
			{ runId, message: "follow-up task" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(resumed.content[0].text).toContain("resumed");
		await harness.tools.get("wait_agent").execute(
			"tool-wait-2",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		state = readRunState(resolveStatePath(runDir));
		expect(state?.status).toBe("completed");
		expect(readRunResult(path.join(runDir, "result.json"))?.turns).toHaveLength(2);
		expect(readRunResult(path.join(runDir, "result.json"))?.finalText).toBe("follow-up done");
	});

	it("does not leak planning auto-enter env into background pi runs", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		process.env.ABSOLUTE_PLAN_AUTOENTER = "1";
		process.env.ABSOLUTE_PLAN_AUTOENTER_PATH = "plans/bench-plan.md";
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const background = await harness.tools.get("spawn_agent").execute(
			"tool-env",
			{ task: "report env", mode: "background" },
			undefined,
			undefined,
			harness.ctx,
		);
		const runId = background.details.runId as string;

		await harness.tools.get("wait_agent").execute(
			"tool-env-wait",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		const runDir = resolveRunDir(tempDir, runId);
		expect(readRunResult(path.join(runDir, "result.json"))?.finalText).toBe("env:unset:unset");
	});

	it("marks background runs as failed when pi returns an assistant error", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const background = await harness.tools.get("spawn_agent").execute(
			"tool-error",
			{ task: "provider error", mode: "background" },
			undefined,
			undefined,
			harness.ctx,
		);
		const runId = background.details.runId as string;

		const waited = await harness.tools.get("wait_agent").execute(
			"tool-error-wait",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(waited.isError).toBe(true);
		const runDir = resolveRunDir(tempDir, runId);
	expect(readRunState(resolveStatePath(runDir))?.status).toBe("failed");
	expect(readRunResult(path.join(runDir, "result.json"))?.error).toBe("Connection error.");
	});

	it("marks background runs as failed when a turn times out", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const background = await harness.tools.get("spawn_agent").execute(
			"tool-timeout",
			{ task: "hang forever", mode: "background", timeoutMs: 100 },
			undefined,
			undefined,
			harness.ctx,
		);
		const runId = background.details.runId as string;

		const waited = await harness.tools.get("wait_agent").execute(
			"tool-timeout-wait",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(waited.isError).toBe(true);
		const runDir = resolveRunDir(tempDir, runId);
		expect(readRunState(resolveStatePath(runDir))?.status).toBe("failed");
		expect(readRunResult(path.join(runDir, "result.json"))?.error).toBe("Subagent turn timed out after 100ms.");
	});

	it("marks background runs as failed when a turn goes idle after partial output", async () => {
		const tempDir = await createTempDir();
		process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT = await createFakePiScript(tempDir);
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const background = await harness.tools.get("spawn_agent").execute(
			"tool-idle-timeout",
			{ task: "hang after token", mode: "background", timeoutMs: 5_000, idleTimeoutMs: 100 },
			undefined,
			undefined,
			harness.ctx,
		);
		const runId = background.details.runId as string;

		const waited = await harness.tools.get("wait_agent").execute(
			"tool-idle-timeout-wait",
			{ runId, timeoutMs: 5_000, pollIntervalMs: 50 },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(waited.isError).toBe(true);
		const runDir = resolveRunDir(tempDir, runId);
		expect(readRunState(resolveStatePath(runDir))?.status).toBe("failed");
		const result = readRunResult(path.join(runDir, "result.json"));
		expect(result?.error).toBe("Subagent turn became idle after 100ms without output.");
		expect(result?.finalText).toBe("partial");
	});
});
