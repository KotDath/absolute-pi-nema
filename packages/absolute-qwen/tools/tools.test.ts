import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { readFileWithEncoding, writeFileWithEncoding } from "../lib/encoding.ts";
import { FileAccessState } from "../lib/file-access-state.ts";
import { registerEdit } from "./edit.ts";
import { registerReadFile } from "./read-file.ts";
import { registerWriteFile } from "./write-file.ts";

type RegisteredToolLike = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
};

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0, tempDirs.length).map(async (dir) => {
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

async function createTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "absolute-qwen-test-"));
	tempDirs.push(dir);
	return dir;
}

function createToolStub(register: (pi: ExtensionAPI) => void): RegisteredToolLike {
	const tools: RegisteredToolLike[] = [];
	const pi = {
		registerTool(tool: RegisteredToolLike) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	register(pi);
	if (tools.length !== 1) {
		throw new Error(`Expected exactly one registered tool, got ${tools.length}.`);
	}
	const [tool] = tools;
	if (!tool) {
		throw new Error("Expected a registered tool.");
	}
	return tool;
}

function createContext(cwd: string) {
	return { cwd } as ExtensionContext;
}

function getTextContent(result: AgentToolResult<unknown>) {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("absolute-qwen tool contracts", () => {
	it("paginates large reads with a bounded default page size", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "large.txt");
		const content = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n");
		await fs.writeFile(filePath, content, "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));

		const result = await readTool.execute(
			"read-1",
			{ file_path: filePath },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Showing lines 1-250 of 300.");
		expect(text).toContain("Use offset=251 to continue.");
		expect(text).not.toContain("line 251");
		expect(result.details).toMatchObject({
			range: {
				startLine: 1,
				endLine: 250,
				totalLines: 300,
			},
			nextOffset: 251,
			truncated: true,
		});
	});

	it("reads a later page when offset and limit are provided", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "paged.txt");
		const content = Array.from({ length: 120 }, (_, index) => `row ${index + 1}`).join("\n");
		await fs.writeFile(filePath, content, "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));

		const result = await readTool.execute(
			"read-1",
			{ file_path: filePath, offset: 101, limit: 20 },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Showing lines 101-120 of 120.");
		expect(text).toContain("row 101");
		expect(text).toContain("row 120");
		expect(result.details).toMatchObject({
			range: {
				startLine: 101,
				endLine: 120,
				totalLines: 120,
			},
			nextOffset: undefined,
			truncated: false,
		});
	});

	it("caps very large line requests and reports the capped continuation point", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "capped.txt");
		const content = Array.from({ length: 600 }, (_, index) => `entry ${index + 1}`).join("\n");
		await fs.writeFile(filePath, content, "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));

		const result = await readTool.execute(
			"read-1",
			{ file_path: filePath, limit: 999 },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Showing lines 1-500 of 600.");
		expect(text).toContain("Line limit applied: maximum 500 lines per call.");
		expect(text).toContain("Use offset=501 to continue.");
	});

	it("truncates very long lines and reports the truncation", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "long-line.txt");
		const longLine = "x".repeat(1_500);
		await fs.writeFile(filePath, `${longLine}\nshort\n`, "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));

		const result = await readTool.execute(
			"read-1",
			{ file_path: filePath },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Line truncated at 1200 characters.");
		expect(text).toContain("Long lines were truncated at 1200 characters.");
		expect(text).toContain("short");
		expect(text).not.toContain("x".repeat(1_350));
	});

	it("caps output size and advances by whole lines", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "char-capped.txt");
		const content = Array.from({ length: 40 }, (_, index) => `${index + 1}: ${"y".repeat(1_000)}`).join("\n");
		await fs.writeFile(filePath, content, "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));

		const result = await readTool.execute(
			"read-1",
			{ file_path: filePath, limit: 40 },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Output capped at 16384 characters.");
		expect(result.details).toMatchObject({
			nextOffset: 17,
			truncated: true,
		});
		expect(text).toContain("Use offset=17 to continue.");
		expect(text).not.toContain("40:");
	});

	it("requires read_file before overwriting an existing file", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "example.txt");
		await fs.writeFile(filePath, "before\n", "utf8");

		const state = new FileAccessState();
		const writeTool = createToolStub((pi) => registerWriteFile(pi, state));

		await expect(
			writeTool.execute(
				"tool-1",
				{ file_path: filePath, content: "after\n" },
				undefined,
				undefined,
				createContext(tempDir),
			),
		).rejects.toThrow(/Use read_file/);
	});

	it("allows overwrite after read_file and preserves existing CRLF line endings", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "example.txt");
		await fs.writeFile(filePath, "alpha\r\nbeta\r\n", "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const writeTool = createToolStub((pi) => registerWriteFile(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		await writeTool.execute(
			"write-1",
			{ file_path: filePath, content: "gamma\nbeta\n" },
			undefined,
			undefined,
			createContext(tempDir),
		);

		const raw = await fs.readFile(filePath, "utf8");
		expect(raw).toBe("gamma\r\nbeta\r\n");
	});

	it("rejects ambiguous exact-match edits without replace_all", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "multi.txt");
		await fs.writeFile(filePath, "needle\nmiddle\nneedle\n", "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const editTool = createToolStub((pi) => registerEdit(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));

		await expect(
			editTool.execute(
				"edit-1",
				{ file_path: filePath, old_string: "needle", new_string: "pin" },
				undefined,
				undefined,
				createContext(tempDir),
			),
		).rejects.toThrow(/matches 2 locations/);
	});

	it("preserves utf-16le with BOM during edit", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "utf16.txt");
		writeFileWithEncoding(filePath, "hello\r\nworld\r\n", {
			encoding: "utf-16le",
			hasBOM: true,
		});

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const editTool = createToolStub((pi) => registerEdit(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		await editTool.execute(
			"edit-1",
			{ file_path: filePath, old_string: "world", new_string: "pi" },
			undefined,
			undefined,
			createContext(tempDir),
		);

		const decoded = readFileWithEncoding(filePath);
		expect(decoded.encoding).toBe("utf-16le");
		expect(decoded.hasBOM).toBe(true);
		expect(decoded.content).toBe("hello\r\npi\r\n");
	});
});
