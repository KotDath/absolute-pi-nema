import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { readFileWithEncoding } from "../lib/encoding.ts";
import type { FileAccessState, FileTrackingDetails } from "../lib/file-access-state.ts";
import { ensureAbsolutePath } from "../lib/path.ts";

const DEFAULT_MAX_CHARS = 50_000;

const Params = Type.Object({
	file_path: Type.String({
		description:
			"The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
	}),
	offset: Type.Optional(
		Type.Number({
			description:
				"Optional: Line number to start reading from. The first line is 1. A value of 0 is accepted as a compatibility alias for the start of the file.",
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

interface ReadFileDetails extends FileTrackingDetails {
	path: string;
	encoding: string;
	range: {
		startLine: number;
		endLine: number;
		totalLines: number;
	};
	truncated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function truncateText(text: string): { text: string; truncated: boolean } {
	if (text.length <= DEFAULT_MAX_CHARS) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, DEFAULT_MAX_CHARS)}\n\n[Output truncated at ${DEFAULT_MAX_CHARS} characters. Narrow the range with offset/limit to continue.]`,
		truncated: true,
	};
}

function prepareArguments(args: unknown): Params {
	if (!args || typeof args !== "object") {
		return args as Params;
	}

	const input = args as { file_path?: unknown; path?: unknown };
	if (typeof input.file_path === "string" || typeof input.path !== "string") {
		return args as Params;
	}

	return {
		...(args as Params),
		file_path: input.path,
	};
}

export function registerReadFile(pi: ExtensionAPI, fileAccessState: FileAccessState) {
	pi.registerTool({
		name: "read_file",
		label: "Read File",
		description:
			"Reads and returns the content of a specified file. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'offset' and 'limit' parameters. Handles text files with specific line ranges.",
		promptSnippet: "Read a file by absolute path, optionally with line offset/limit.",
		promptGuidelines: [
			"Use read_file before edit or before overwriting an existing file with write_file.",
			"Use read_file instead of shell commands such as cat, sed, or python for file reads.",
		],
		parameters: Params,
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<ReadFileDetails>> {
			throwIfAborted(signal);

			const filePath = ensureAbsolutePath(params.file_path, "File path");
			const { content, encoding } = readFileWithEncoding(filePath);
			throwIfAborted(signal);

			const lines = content.split(/\r?\n/);
			const totalLines = lines.length;
			const startLine = params.offset === undefined ? 1 : Math.max(1, Math.trunc(params.offset));
			const startIndex = startLine - 1;

			if (startIndex >= totalLines) {
				throw new Error(`Offset ${startLine} is beyond end of file (${totalLines} line(s) total).`);
			}

			const limit = params.limit === undefined ? totalLines - startIndex : Math.max(1, Math.trunc(params.limit));
			const endIndex = Math.min(startIndex + limit, totalLines);
			const selectedLines = lines.slice(startIndex, endIndex);
			let text = selectedLines.join("\n");
			let truncated = false;

			const prefix =
				startIndex > 0 || endIndex < totalLines
					? `Showing lines ${startIndex + 1}-${endIndex} of ${totalLines}.\n\n`
					: "";
			const truncatedResult = truncateText(text);
			text = truncatedResult.text;
			truncated = truncatedResult.truncated;

			if (!truncated && endIndex < totalLines) {
				text += `\n\n[${totalLines - endIndex} more line(s) remain. Use offset=${endIndex + 1} to continue.]`;
			}

			const version = fileAccessState.markRead(filePath);

			return {
				content: [{ type: "text", text: `${prefix}${text}`.trim() }],
				details: {
					path: filePath,
					encoding,
					range: {
						startLine: startIndex + 1,
						endLine: endIndex,
						totalLines,
					},
					truncated,
					tracking: {
						action: "read",
						path: filePath,
						version,
					},
				},
			};
		},
	});
}
