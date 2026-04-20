import fs from "node:fs/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createUnifiedDiff, summarizeDiff } from "../lib/diff.ts";
import { preserveLineEnding, readFileWithEncoding, writeFileWithEncoding } from "../lib/encoding.ts";
import type { FileAccessState, FileTrackingDetails } from "../lib/file-access-state.ts";
import { ensureAbsolutePath } from "../lib/path.ts";

const Params = Type.Object(
	{
		file_path: Type.String({ description: "The absolute path to the file to modify." }),
		old_string: Type.String({
			description:
				"The exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code).",
		}),
		new_string: Type.String({
			description:
				"The exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code).",
		}),
		replace_all: Type.Optional(
			Type.Boolean({ description: "Set to true to replace every occurrence that matches `old_string`." }),
		),
	},
	{ additionalProperties: false },
);

type Params = Static<typeof Params>;

interface EditDetails extends FileTrackingDetails {
	path: string;
	diffPreview?: string;
	fullDiffPath?: string;
	diffTruncated: boolean;
	firstChangedLine?: number;
	replacedCount: number;
}

type EditRenderArgs = Params & {
	path?: unknown;
	oldText?: unknown;
	newText?: unknown;
	search?: unknown;
	content?: unknown;
	replaceAll?: unknown;
};

type EditRenderTheme = {
	fg: (token: "toolTitle" | "accent", text: string) => string;
	bold: (text: string) => string;
};

function countOccurrences(content: string, search: string): number {
	if (search.length === 0) {
		return 0;
	}

	let count = 0;
	let position = content.indexOf(search);
	while (position !== -1) {
		count++;
		position = content.indexOf(search, position + search.length);
	}
	return count;
}

function findFirstChangedLine(original: string, updated: string): number | undefined {
	const originalLines = original.split(/\r?\n/);
	const updatedLines = updated.split(/\r?\n/);
	const maxLines = Math.max(originalLines.length, updatedLines.length);

	for (let index = 0; index < maxLines; index++) {
		if (originalLines[index] !== updatedLines[index]) {
			return index + 1;
		}
	}

	return undefined;
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function prepareArguments(args: unknown): Params {
	if (!args || typeof args !== "object") {
		return args as Params;
	}

	const input = args as EditRenderArgs;

	return {
		...(args as Params),
		file_path:
			typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: (input.file_path as string),
		old_string:
			typeof input.old_string === "string"
				? input.old_string
				: typeof input.oldText === "string"
					? input.oldText
					: typeof input.search === "string"
						? input.search
						: (input.old_string as string),
		new_string:
			typeof input.new_string === "string"
				? input.new_string
				: typeof input.newText === "string"
					? input.newText
					: typeof input.content === "string"
						? input.content
						: (input.new_string as string),
		replace_all:
			typeof input.replace_all === "boolean"
				? input.replace_all
				: typeof input.replaceAll === "boolean"
					? input.replaceAll
					: undefined,
	};
}

function formatEditCall(args: EditRenderArgs | undefined, theme: EditRenderTheme) {
	const filePath =
		typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "...";
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", filePath)}`;
}

function getTextContent(result: AgentToolResult<EditDetails>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

export function registerEdit(pi: ExtensionAPI, fileAccessState: FileAccessState) {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Replaces exact text within a file. Always read the file with read_file first. old_string must match the current file contents exactly, including whitespace and line breaks. Set replace_all to true only when every matching occurrence should be changed.",
		promptSnippet: "Replace exact text in a file using absolute path and full literal context.",
		promptGuidelines: [
			"Use read_file before edit.",
			"old_string must match the current file contents exactly, including whitespace and line endings.",
			"Use replace_all only when every exact occurrence should be changed.",
		],
		parameters: Params,
		renderShell: "self",
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<EditDetails>> {
			throwIfAborted(signal);

			const filePath = ensureAbsolutePath(params.file_path, "File path");
			if (params.old_string.length === 0) {
				throw new Error("old_string must not be empty.");
			}

			return withFileMutationQueue(filePath, async () => {
				throwIfAborted(signal);
				fileAccessState.requireFreshRead(filePath, "edit");

				try {
					const stat = await fs.stat(filePath);
					if (!stat.isFile()) {
						throw new Error(`Path is not a file: ${filePath}`);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						throw new Error(`File not found: ${filePath}`);
					}
					throw error;
				}

				const decoded = readFileWithEncoding(filePath);
				const originalContent = decoded.content;
				const occurrences = countOccurrences(originalContent, params.old_string);

				if (occurrences === 0) {
					throw new Error(
						`old_string was not found in ${filePath}. Read the file again and make sure the match is exact.`,
					);
				}

				if (occurrences > 1 && !params.replace_all) {
					throw new Error(
						`old_string matches ${occurrences} locations in ${filePath}. Add more surrounding context or set replace_all to true.`,
					);
				}

				const replacedCount = params.replace_all ? occurrences : 1;
				let nextContent = params.replace_all
					? originalContent.split(params.old_string).join(params.new_string)
					: originalContent.replace(params.old_string, params.new_string);

				nextContent = preserveLineEnding(originalContent, nextContent);
				writeFileWithEncoding(filePath, nextContent, {
					encoding: decoded.encoding,
					hasBOM: decoded.hasBOM,
				});
				throwIfAborted(signal);

				const diff = createUnifiedDiff(originalContent, nextContent, filePath);
				const diffSummary = summarizeDiff(diff);
				const version = fileAccessState.markMutation(filePath);
				const summaryParts = [`Edited ${filePath}`, `${replacedCount} replacement(s)`];
				const firstChangedLine = findFirstChangedLine(originalContent, nextContent);
				if (firstChangedLine !== undefined) {
					summaryParts.push(`first changed line ${firstChangedLine}`);
				}
				const textParts = [summaryParts.join(" | ")];
				if (diffSummary.preview) {
					textParts.push(diffSummary.preview);
				}

				return {
					content: [
						{
							type: "text",
							text: textParts.join("\n\n"),
						},
					],
					details: {
						path: filePath,
						diffPreview: diffSummary.preview || undefined,
						fullDiffPath: diffSummary.fullDiffPath,
						diffTruncated: diffSummary.truncated,
						firstChangedLine,
						replacedCount,
						tracking: {
							action: "edit",
							path: filePath,
							version,
						},
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatEditCall(args as EditRenderArgs | undefined, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const typedResult = result as AgentToolResult<EditDetails>;
			const output = context.isError ? getTextContent(typedResult) : typedResult.details?.diffPreview;
			if (!output) {
				const container = (context.lastComponent as Container | undefined) ?? new Container();
				container.clear();
				return container;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${context.isError ? theme.fg("error", output) : theme.fg("toolOutput", output)}`);
			return text;
		},
	});
}
