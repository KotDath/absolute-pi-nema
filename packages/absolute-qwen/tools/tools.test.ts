import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { readFileWithEncoding, writeFileWithEncoding } from "../lib/encoding.ts";
import { FileAccessState } from "../lib/file-access-state.ts";
import { registerEdit } from "./edit.ts";
import { registerGlob } from "./glob.ts";
import { registerGrepSearch } from "./grep-search.ts";
import { registerListDirectory } from "./list-directory.ts";
import { registerReadFile } from "./read-file.ts";
import { registerRunShell } from "./run-shell.ts";
import { registerWriteFile } from "./write-file.ts";

type RegisteredToolLike = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
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

	it("supports grep_search on a single file target", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "single.ts");
		await fs.writeFile(filePath, "// TODO: single target\nconst x = 1;\n", "utf8");

		const grepTool = createToolStub((pi) => registerGrepSearch(pi));
		const result = await grepTool.execute(
			"grep-1",
			{ pattern: "TODO", path: filePath },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain(`Found 1 match for "TODO" in ${filePath}.`);
		expect(text).toContain("File: single.ts");
		expect(text).toContain("L1: // TODO: single target");
		expect(result.details).toMatchObject({
			searchPath: filePath,
			totalMatches: 1,
			shownMatches: 1,
			totalFiles: 1,
			shownFiles: 1,
			truncated: false,
		});
	});

	it("bounds grep_search output and asks the agent to refine broad searches", async () => {
		const tempDir = await createTempDir();
		await fs.writeFile(
			path.join(tempDir, "alpha.txt"),
			Array.from({ length: 6 }, (_, index) => `TODO alpha ${index + 1}`).join("\n"),
			"utf8",
		);
		await fs.writeFile(
			path.join(tempDir, "beta.txt"),
			Array.from({ length: 3 }, (_, index) => `TODO beta ${index + 1}`).join("\n"),
			"utf8",
		);

		const grepTool = createToolStub((pi) => registerGrepSearch(pi));
		const result = await grepTool.execute(
			"grep-1",
			{ pattern: "TODO", path: tempDir },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Showing 7 of 9 matches across 2 of 2 files.");
		expect(text).toContain("Refine the pattern, path, or glob to continue.");
		expect(text).toContain("File: alpha.txt");
		expect(text).toContain("L4: TODO alpha 4");
		expect(text).not.toContain("L5: TODO alpha 5");
		expect(result.details).toMatchObject({
			searchPath: tempDir,
			totalMatches: 9,
			shownMatches: 7,
			totalFiles: 2,
			shownFiles: 2,
			truncated: true,
		});
	});

	it("truncates long grep_search snippets", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "long.txt");
		await fs.writeFile(filePath, `TODO ${"z".repeat(400)}\n`, "utf8");

		const grepTool = createToolStub((pi) => registerGrepSearch(pi));
		const result = await grepTool.execute(
			"grep-1",
			{ pattern: "TODO", path: filePath },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("snippet truncated at 240 characters");
		expect(text).toContain("Some snippets were truncated at 240 characters.");
	});

	it("reports shown versus total results for glob truncation", async () => {
		const tempDir = await createTempDir();
		for (let index = 1; index <= 110; index++) {
			await fs.writeFile(path.join(tempDir, `file-${index}.txt`), `${index}\n`, "utf8");
		}

		const globTool = createToolStub((pi) => registerGlob(pi));
		const result = await globTool.execute(
			"glob-1",
			{ pattern: "*.txt", path: tempDir },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("Showing 100 of 110");
		expect(text).toContain("Narrow the pattern or path to continue.");
		expect(result.details).toMatchObject({
			searchDir: tempDir,
			total: 110,
			shown: 100,
			truncated: true,
		});
	});

	it("reports shown versus total results for list_directory truncation", async () => {
		const tempDir = await createTempDir();
		for (let index = 1; index <= 105; index++) {
			await fs.writeFile(path.join(tempDir, `entry-${index}.txt`), `${index}\n`, "utf8");
		}

		const listTool = createToolStub((pi) => registerListDirectory(pi));
		const result = await listTool.execute("list-1", { path: tempDir }, undefined, undefined, createContext(tempDir));
		const text = getTextContent(result);

		expect(text).toContain("Showing 100 of 105.");
		expect(text).toContain("Narrow the path or ignore patterns to continue.");
		expect(result.details).toMatchObject({
			path: tempDir,
			total: 105,
			shown: 100,
			truncated: true,
		});
	});

	it("returns an inline diff preview for small edits", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "small-edit.txt");
		await fs.writeFile(filePath, "hello\nworld\n", "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const editTool = createToolStub((pi) => registerEdit(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		const result = await editTool.execute(
			"edit-1",
			{ file_path: filePath, old_string: "hello", new_string: "hi" },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			diffPreview?: string;
			fullDiffPath?: string;
			diffTruncated: boolean;
		};

		expect(text).toContain("Edited");
		expect(text).toContain("+hi");
		expect(details.diffPreview).toContain("+hi");
		expect(details.diffTruncated).toBe(false);
		expect(details.fullDiffPath).toBeUndefined();
	});

	it("writes a full diff artifact when an edit diff is too large for inline preview", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "large-edit.txt");
		const beforeSuffix = "A".repeat(80);
		const afterSuffix = "B".repeat(80);
		await fs.writeFile(
			filePath,
			Array.from({ length: 200 }, (_, index) => `before line ${index + 1} ${beforeSuffix}`).join("\n"),
			"utf8",
		);

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const editTool = createToolStub((pi) => registerEdit(pi, state));

		const oldBlock = Array.from({ length: 120 }, (_, index) => `before line ${index + 1} ${beforeSuffix}`).join("\n");
		const newBlock = Array.from({ length: 120 }, (_, index) => `after line ${index + 1} ${afterSuffix}`).join("\n");

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		const result = await editTool.execute(
			"edit-1",
			{ file_path: filePath, old_string: oldBlock, new_string: newBlock },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			diffPreview?: string;
			fullDiffPath?: string;
			diffTruncated: boolean;
		};

		expect(text).toContain("Diff preview truncated.");
		expect(details.diffTruncated).toBe(true);
		expect(details.fullDiffPath).toBeTruthy();
		const fullDiffPath = details.fullDiffPath;
		if (!fullDiffPath) {
			throw new Error("Expected fullDiffPath to be defined.");
		}
		const diff = await fs.readFile(fullDiffPath, "utf8");
		expect(diff).toContain("after line 120");
		expect(diff).toContain("before line 1");
	});

	it("returns small run_shell_command output directly", async () => {
		const tempDir = await createTempDir();
		const shellTool = createToolStub((pi) => registerRunShell(pi));

		const result = await shellTool.execute(
			"shell-1",
			{ command: "printf 'hello\\nworld\\n'", is_background: false },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);

		expect(text).toContain("hello");
		expect(text).toContain("world");
		expect(result.details).toMatchObject({
			cwd: tempDir,
			background: false,
			truncated: false,
		});
	});

	it("streams long run_shell_command output and saves the full log", async () => {
		const tempDir = await createTempDir();
		const shellTool = createToolStub((pi) => registerRunShell(pi));
		const updates: AgentToolResult<unknown>[] = [];

		const result = await shellTool.execute(
			"shell-1",
			{
				command: "for i in $(seq 1 120); do echo line-$i; done",
				is_background: false,
			},
			undefined,
			(update) => updates.push(update),
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			fullOutputPath?: string;
			truncated?: boolean;
		};

		expect(updates.length).toBeGreaterThan(0);
		expect(text).toContain("Full output:");
		expect(text).toContain("Command completed successfully.");
		expect(details.truncated).toBe(true);
		expect(details.fullOutputPath).toBeTruthy();
		const fullOutputPath = details.fullOutputPath;
		if (!fullOutputPath) {
			throw new Error("Expected fullOutputPath to be defined.");
		}
		const log = await fs.readFile(fullOutputPath, "utf8");
		expect(log).toContain("line-1");
		expect(log).toContain("line-120");
	});

	it("includes buffered output in run_shell_command errors", async () => {
		const tempDir = await createTempDir();
		const shellTool = createToolStub((pi) => registerRunShell(pi));

		await expect(
			shellTool.execute(
				"shell-1",
				{ command: "printf 'bad\\n'; exit 7", is_background: false },
				undefined,
				undefined,
				createContext(tempDir),
			),
		).rejects.toThrow(/bad[\s\S]*Exit code: 7/);
	});

	it("returns summary-only output when write_file creates a new file", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "new-file.txt");

		const state = new FileAccessState();
		const writeTool = createToolStub((pi) => registerWriteFile(pi, state));

		const result = await writeTool.execute(
			"write-1",
			{ file_path: filePath, content: "created\n" },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			overwritten: boolean;
			diffPreview?: string;
			diffTruncated: boolean;
			lineCount: number;
		};

		expect(text).toContain("Created");
		expect(text).not.toContain("---");
		expect(details.overwritten).toBe(false);
		expect(details.diffPreview).toBeUndefined();
		expect(details.diffTruncated).toBe(false);
		expect(details.lineCount).toBe(1);
	});

	it("returns an inline diff preview for small write_file overwrites", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "overwrite.txt");
		await fs.writeFile(filePath, "alpha\nbeta\n", "utf8");

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const writeTool = createToolStub((pi) => registerWriteFile(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		const result = await writeTool.execute(
			"write-1",
			{ file_path: filePath, content: "gamma\nbeta\n" },
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			diffPreview?: string;
			fullDiffPath?: string;
			diffTruncated: boolean;
			firstChangedLine?: number;
		};

		expect(text).toContain("+gamma");
		expect(details.diffPreview).toContain("+gamma");
		expect(details.diffTruncated).toBe(false);
		expect(details.fullDiffPath).toBeUndefined();
		expect(details.firstChangedLine).toBe(1);
	});

	it("writes a full diff artifact for large write_file overwrites", async () => {
		const tempDir = await createTempDir();
		const filePath = path.join(tempDir, "large-write.txt");
		const beforeSuffix = "C".repeat(80);
		const afterSuffix = "D".repeat(80);
		await fs.writeFile(
			filePath,
			Array.from({ length: 150 }, (_, index) => `before write ${index + 1} ${beforeSuffix}`).join("\n"),
			"utf8",
		);

		const state = new FileAccessState();
		const readTool = createToolStub((pi) => registerReadFile(pi, state));
		const writeTool = createToolStub((pi) => registerWriteFile(pi, state));

		await readTool.execute("read-1", { file_path: filePath }, undefined, undefined, createContext(tempDir));
		const result = await writeTool.execute(
			"write-1",
			{
				file_path: filePath,
				content: Array.from({ length: 150 }, (_, index) => `after write ${index + 1} ${afterSuffix}`).join("\n"),
			},
			undefined,
			undefined,
			createContext(tempDir),
		);
		const text = getTextContent(result);
		const details = result.details as {
			diffPreview?: string;
			fullDiffPath?: string;
			diffTruncated: boolean;
		};

		expect(text).toContain("Diff preview truncated.");
		expect(details.diffTruncated).toBe(true);
		expect(details.fullDiffPath).toBeTruthy();
		const fullDiffPath = details.fullDiffPath;
		if (!fullDiffPath) {
			throw new Error("Expected fullDiffPath to be defined.");
		}
		const diff = await fs.readFile(fullDiffPath, "utf8");
		expect(diff).toContain("after write 150");
		expect(diff).toContain("before write 1");
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
