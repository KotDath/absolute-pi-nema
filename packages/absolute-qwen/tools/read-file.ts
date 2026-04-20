import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { readFileWithEncoding } from "../lib/encoding.ts";
import type { FileAccessState, FileTrackingDetails } from "../lib/file-access-state.ts";
import { ensureAbsolutePath } from "../lib/path.ts";

const DEFAULT_LIMIT_LINES = 250;
const MAX_LIMIT_LINES = 500;
const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_LINE_CHARS = 1_200;

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
	nextOffset?: number;
	truncated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function truncateLine(line: string): { text: string; truncated: boolean } {
	if (line.length <= MAX_LINE_CHARS) {
		return { text: line, truncated: false };
	}
	return {
		text: `${line.slice(0, MAX_LINE_CHARS)} [Line truncated at ${MAX_LINE_CHARS} characters.]`,
		truncated: true,
	};
}

function formatFooter(options: {
	totalLines: number;
	endLine: number;
	nextOffset?: number;
	lineLimitApplied: boolean;
	outputCharLimitApplied: boolean;
	longLinesTruncated: boolean;
}) {
	const notes: string[] = [];
	if (options.lineLimitApplied) {
		notes.push(`Line limit applied: maximum ${MAX_LIMIT_LINES} lines per call.`);
	}
	if (options.outputCharLimitApplied) {
		notes.push(`Output capped at ${MAX_OUTPUT_CHARS} characters.`);
	}
	if (options.longLinesTruncated) {
		notes.push(`Long lines were truncated at ${MAX_LINE_CHARS} characters.`);
	}
	if (options.nextOffset !== undefined && options.endLine < options.totalLines) {
		notes.push(
			`${options.totalLines - options.endLine} more line(s) remain. Use offset=${options.nextOffset} to continue.`,
		);
	}
	return notes.length > 0 ? `\n\n[${notes.join(" ")}]` : "";
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
			"Reads a file by absolute path using bounded, line-oriented pagination. The response always reports which lines were shown and how to continue reading with offset/limit. Use grep_search first to find relevant regions in large files, then read_file for the local context you need.",
		promptSnippet: "Read a file by absolute path with bounded line pagination.",
		promptGuidelines: [
			"Use read_file before edit or before overwriting an existing file with write_file.",
			"Use read_file instead of shell commands such as cat, sed, or python for file reads.",
			"Use grep_search first when locating symbols, errors, or exact strings in large files, then read_file around the relevant region.",
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

			const requestedLimit = params.limit === undefined ? DEFAULT_LIMIT_LINES : Math.max(1, Math.trunc(params.limit));
			const lineLimit = Math.min(requestedLimit, MAX_LIMIT_LINES);
			const requestedEndIndex = Math.min(startIndex + lineLimit, totalLines);
			const selectedLines: string[] = [];
			let endIndex = startIndex;
			let currentChars = 0;
			let outputCharLimitApplied = false;
			let longLinesTruncated = false;

			for (let index = startIndex; index < requestedEndIndex; index++) {
				const truncatedLine = truncateLine(lines[index] ?? "");
				longLinesTruncated ||= truncatedLine.truncated;
				const separator = selectedLines.length === 0 ? "" : "\n";
				const nextChunk = `${separator}${truncatedLine.text}`;
				if (selectedLines.length > 0 && currentChars + nextChunk.length > MAX_OUTPUT_CHARS) {
					outputCharLimitApplied = true;
					break;
				}
				selectedLines.push(truncatedLine.text);
				currentChars += nextChunk.length;
				endIndex = index + 1;
			}

			if (selectedLines.length === 0) {
				const truncatedLine = truncateLine(lines[startIndex] ?? "");
				selectedLines.push(truncatedLine.text);
				longLinesTruncated ||= truncatedLine.truncated;
				endIndex = startIndex + 1;
			}

			const text = selectedLines.join("\n");
			const nextOffset = endIndex < totalLines ? endIndex + 1 : undefined;
			const lineLimitApplied = requestedLimit > MAX_LIMIT_LINES;
			const truncated = lineLimitApplied || outputCharLimitApplied || longLinesTruncated || nextOffset !== undefined;
			const header = `Showing lines ${startIndex + 1}-${endIndex} of ${totalLines}.`;
			const footer = formatFooter({
				totalLines,
				endLine: endIndex,
				nextOffset,
				lineLimitApplied,
				outputCharLimitApplied,
				longLinesTruncated,
			});

			const version = fileAccessState.markRead(filePath);

			return {
				content: [{ type: "text", text: `${header}\n\n${text}${footer}`.trim() }],
				details: {
					path: filePath,
					encoding,
					range: {
						startLine: startIndex + 1,
						endLine: endIndex,
						totalLines,
					},
					nextOffset,
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
