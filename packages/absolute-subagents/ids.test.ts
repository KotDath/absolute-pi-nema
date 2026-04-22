import { describe, expect, it } from "vitest";
import { createMessageId, createRunId } from "./ids.js";

describe("absolute-subagents ids", () => {
	it("creates unique run ids", () => {
		expect(createRunId()).not.toBe(createRunId());
	});

	it("creates message ids scoped to the run id", () => {
		expect(createMessageId("run-1")).toContain("run-1");
	});
});

