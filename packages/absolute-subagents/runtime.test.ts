import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import absoluteSubagentsExtension from "./index.js";
import { createExtensionHarness } from "./test-harness.js";

const tempDirs: string[] = [];

async function createTempDir() {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "absolute-subagents-runtime-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("absolute-subagents runtime", () => {
	it("registers the expected tool surface", async () => {
		const harness = createExtensionHarness();
		absoluteSubagentsExtension(harness.pi);

		expect(harness.tools.has("spawn_agent")).toBe(true);
		expect(harness.tools.has("send_agent_message")).toBe(true);
		expect(harness.tools.has("wait_agent")).toBe(true);
		expect(harness.tools.has("stop_agent")).toBe(true);
		expect(harness.tools.has("list_agents")).toBe(true);
	});

	it("lists no runs when runtime is empty", async () => {
		const tempDir = await createTempDir();
		const harness = createExtensionHarness({ cwd: tempDir });
		absoluteSubagentsExtension(harness.pi);

		const result = await harness.tools.get("list_agents").execute("tool-1", {}, undefined, undefined, harness.ctx);
		expect(result.content).toEqual([{ type: "text", text: "No subagent runs found." }]);
	});
});

