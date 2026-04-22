import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createUnifiedDiff, summarizeDiff } from "../lib/diff.ts";
import { preserveLineEnding, readFileWithEncoding, writeFileWithEncoding } from "../lib/encoding.ts";
import type { FileAccessState, FileTrackingDetails } from "../lib/file-access-state.ts";
import { ensureAbsolutePath } from "../lib/path.ts";

const Params = Type.Object({
	path: Type.String({
		description:
			"The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
	}),
	content: Type.String({ description: "The content to write to the file." }),
});

type Params = Static<typeof Params>;

interface WriteFileDetails extends FileTrackingDetails {
	path: string;
	overwritten: boolean;
	lineCount: number;
	diffPreview?: string;
	fullDiffPath?: string;
	diffTruncated: boolean;
	firstChangedLine?: number;
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function countLines(content: string) {
	if (content.length === 0) {
		return 0;
	}
	return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

function findFirstChangedLine(previousContent: string, nextContent: string) {
	const previousLines = previousContent.split(/\r?\n/);
	const nextLines = nextContent.split(/\r?\n/);
	const maxLines = Math.max(previousLines.length, nextLines.length);

	for (let index = 0; index < maxLines; index++) {
		if (previousLines[index] !== nextLines[index]) {
			return index + 1;
		}
	}

	return undefined;
}

function prepareArguments(args: unknown): Params {
	if (!args || typeof args !== "object") {
		return args as Params;
	}

	const input = args as { file_path?: unknown; path?: unknown };
	if (typeof input.path === "string" || typeof input.file_path !== "string") {
		return args as Params;
	}

	return {
		...(args as Params),
		path: input.file_path,
	};
}

export function registerWriteFile(pi: ExtensionAPI, fileAccessState: FileAccessState) {
	pi.registerTool({
		name: "write",
		label: "Write",
		description:
			"PURPOSE: Write a file by absolute path, creating parent directories when needed. Use this for new files and full rewrites. Overwriting an existing file requires a fresh read of that same path first.\n" +
			"KEYWORDS: [FileWrite, write_file, AbsolutePath, CreateFile, RewriteFile, ParentDirs, ReadBeforeOverwrite, SummaryFirst]",
		promptSnippet: "FileWrite write_file absolute-path create rewrite read-before-overwrite",
		promptGuidelines: [
			"Create-or-rewrite: use write for new files or complete rewrites.",
			"Read-before-overwrite: read an existing file with read before overwriting it with write.",
		],
		parameters: Params,
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<WriteFileDetails>> {
			throwIfAborted(signal);

			const filePath = ensureAbsolutePath(params.path, "File path");
			return withFileMutationQueue(filePath, async () => {
				throwIfAborted(signal);

				const dir = path.dirname(filePath);
				await fs.mkdir(dir, { recursive: true });

				let overwritten = false;
				let existingContent = "";
				let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
				let hasBOM = false;

				try {
					const stat = await fs.stat(filePath);
					if (!stat.isFile()) {
						throw new Error(`Path is not a file: ${filePath}`);
					}
					overwritten = true;
					fileAccessState.requireFreshRead(filePath, "write");
					const decoded = readFileWithEncoding(filePath);
					existingContent = decoded.content;
					encoding = decoded.encoding;
					hasBOM = decoded.hasBOM;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
				}

				const nextContent = overwritten ? preserveLineEnding(existingContent, params.content) : params.content;
				writeFileWithEncoding(filePath, nextContent, { encoding, hasBOM });
				throwIfAborted(signal);

				const diff = createUnifiedDiff(existingContent, nextContent, filePath);
				const diffSummary = overwritten
					? summarizeDiff(diff)
					: { preview: "", truncated: false, fullDiffPath: undefined };
				const version = fileAccessState.markMutation(filePath);
				const summary = overwritten ? `Overwrote ${filePath}` : `Created ${filePath}`;
				const lineCount = countLines(nextContent);
				const firstChangedLine = overwritten ? findFirstChangedLine(existingContent, nextContent) : 1;
				const textParts = [`${summary} | ${lineCount} line(s)`];
				if (diffSummary.preview) {
					textParts.push(diffSummary.preview);
				}

				return {
					content: [{ type: "text", text: textParts.join("\n\n") }],
					details: {
						path: filePath,
						overwritten,
						lineCount,
						diffPreview: diffSummary.preview || undefined,
						fullDiffPath: diffSummary.fullDiffPath,
						diffTruncated: diffSummary.truncated,
						firstChangedLine: overwritten ? firstChangedLine : 1,
						tracking: {
							action: "write",
							path: filePath,
							version,
						},
					},
				};
			});
		},
	});
}
