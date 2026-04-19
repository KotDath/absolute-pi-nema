import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { truncateOutput } from "../lib/truncate.ts";

const Params = Type.Object({
	file_path: Type.String({
		description:
			"The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
	}),
	offset: Type.Optional(
		Type.Number({
			description:
				"Optional: For text files, the 0-based line number to start reading from. Use with 'limit' to paginate through large files.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (up to a default limit).",
		}),
	),
});

type Params = Static<typeof Params>;

export function registerReadFile(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_file",
		label: "Read File",
		description:
			"Reads and returns the content of a specified file. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'offset' and 'limit' parameters. Handles text files with specific line ranges.",
		promptSnippet: "Read a file by absolute path, optionally with line offset/limit.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const filePath = path.resolve(params.file_path);

			if (!path.isAbsolute(params.file_path)) {
				return {
					content: [{ type: "text", text: `Error: File path must be absolute, but was relative: ${params.file_path}` }],
					details: {},
				};
			}

			if (!fs.existsSync(filePath)) {
				return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }], details: {} };
			}

			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.split("\n");
				const totalLines = lines.length;

				const offset = params.offset ?? 0;
				const limit = params.limit ?? totalLines;
				const endLine = Math.min(offset + limit, totalLines);
				const selectedLines = lines.slice(offset, endLine);

				let text = selectedLines.join("\n");

				if (offset > 0 || endLine < totalLines) {
					text = `Showing lines ${offset + 1}-${endLine} of ${totalLines} total lines.\n\n---\n\n${text}`;
				}

				text = truncateOutput(text);

				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error reading file: ${message}` }], details: {} };
			}
		},
	});
}
