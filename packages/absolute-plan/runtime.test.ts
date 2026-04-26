import { describe, expect, it } from "vitest";
import absolutePlanExtension from "./index.js";
import { PLAN_COMMAND_NAME, PLAN_SHORTCUT, STATUS_KEY } from "./constants.js";
import { createExtensionHarness } from "./test-harness.js";

describe("absolute-plan runtime wiring", () => {
	it("registers command, shortcut, and tools", () => {
		const harness = createExtensionHarness();
		absolutePlanExtension(harness.pi);

		expect(harness.commands.has(PLAN_COMMAND_NAME)).toBe(true);
		expect(harness.shortcuts.has(PLAN_SHORTCUT)).toBe(true);
		expect(harness.tools.has("set_plan")).toBe(true);
		expect(harness.tools.has("get_plan")).toBe(true);
		expect(harness.tools.has("request_user_input")).toBe(true);
		expect(harness.tools.has("compile_plan")).toBe(true);
		expect(harness.tools.has("plan_exit")).toBe(true);
		expect(harness.tools.has("get_task_graph")).toBe(true);
		expect(harness.tools.has("get_runs")).toBe(true);
		expect(harness.tools.has("get_run_trace")).toBe(true);
		expect(harness.tools.has("get_cell_state")).toBe(true);
		expect(harness.tools.has("task_update")).toBe(true);
		expect(harness.tools.has("record_task_result")).toBe(true);
		expect(harness.tools.has("pause_execution")).toBe(true);
		expect(harness.tools.has("resume_execution")).toBe(true);
	});

	it("injects planning prompt only while active and restores from session entries", async () => {
		const harness = createExtensionHarness();
		absolutePlanExtension(harness.pi);

		const [inactive] = await harness.emitAsync("before_agent_start", { systemPrompt: "base" }, harness.ctx);
		expect(inactive).toBeUndefined();

		harness.entries.push({
			id: "entry-restore",
			type: "custom",
			customType: "absolute-plan:state",
			data: {
				version: 2,
				active: true,
				mode: "planning",
				status: "draft",
				planFilePath: "/tmp/restore.md",
				previousActiveTools: ["read", "write", "edit", "bash", "list_directory", "grep_search", "glob"],
				plan: {
					version: 1,
					goal: "Restore plan",
					assumptions: [],
					openQuestions: [],
					files: ["packages/absolute-plan/index.ts"],
					items: [
						{
							id: "restore",
							title: "Restore runtime",
							status: "pending",
							outcome: "Restore planning mode from entries.",
							validation: "Run state restore test.",
							dependsOn: [],
							files: [],
							executionMode: "single",
						},
					],
					verification: ["Run runtime tests."],
					risks: [],
					status: "draft",
				},
			},
		});

		await harness.emitAsync("session_start", { type: "session_start" }, harness.ctx);
		expect(harness.getActiveTools()).toEqual([
			"read",
			"list_directory",
			"grep_search",
			"glob",
			"set_plan",
			"get_plan",
			"request_user_input",
			"compile_plan",
			"plan_exit",
		]);
		expect(harness.statusMap.get(STATUS_KEY)).toBe("PLAN draft 1 items planning");

		const [active] = await harness.emitAsync("before_agent_start", { systemPrompt: "base" }, harness.ctx);
		expect(active.systemPrompt).toContain("You are in planning mode.");
		expect(active.message.customType).toBe("absolute-plan:context");
	});

	it("blocks mutating tools during planning mode", async () => {
		const harness = createExtensionHarness();
		absolutePlanExtension(harness.pi);
		await harness.commands.get("plan").handler("", harness.ctx);

		const [writeBlock] = await harness.emitAsync("tool_call", { toolName: "write", input: {} }, harness.ctx);
		expect(writeBlock).toEqual({
			block: true,
			reason: "Planning mode blocks write. Exit planning mode before making changes.",
		});

		const [readResult] = await harness.emitAsync("tool_call", { toolName: "read", input: {} }, harness.ctx);
		expect(readResult).toBeUndefined();
	});

	it("returns empty observability views when no runs or cells exist", async () => {
		const harness = createExtensionHarness();
		absolutePlanExtension(harness.pi);

		const runs = await harness.tools.get("get_runs").execute("tool-runs", {}, undefined, undefined, harness.ctx);
		expect(runs.content).toEqual([{ type: "text", text: "No subagent runs found." }]);

		const trace = await harness.tools.get("get_run_trace").execute(
			"tool-trace",
			{ runId: "missing-run" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(trace.isError).toBe(true);
		expect(trace.content).toEqual([{ type: "text", text: "Unknown run: missing-run" }]);
	});
});
