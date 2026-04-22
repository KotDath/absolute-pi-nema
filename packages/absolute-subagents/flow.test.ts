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
const text = task.includes("follow-up") ? "follow-up done" : task.includes("sleep") ? "sleep done" : "initial done";
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
});
