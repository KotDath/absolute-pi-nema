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

describe("absolute-qwen tool contracts", () => {
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
