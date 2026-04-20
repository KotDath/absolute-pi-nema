import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createUnifiedDiff } from "../lib/diff.ts";
import { preserveLineEnding, readFileWithEncoding, writeFileWithEncoding } from "../lib/encoding.ts";
import type { FileAccessState, FileTrackingDetails } from "../lib/file-access-state.ts";
import { ensureAbsolutePath } from "../lib/path.ts";

const Params = Type.Object({
	file_path: Type.String({
		description:
			"The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
	}),
	content: Type.String({ description: "The content to write to the file." }),
});

type Params = Static<typeof Params>;

interface WriteFileDetails extends FileTrackingDetails {
	path: string;
	overwritten: boolean;
	diff?: string;
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

	const input = args as { file_path?: unknown; path?: unknown };
	if (typeof input.file_path === "string" || typeof input.path !== "string") {
		return args as Params;
	}

	return {
		...(args as Params),
		file_path: input.path,
	};
}

export function registerWriteFile(pi: ExtensionAPI, fileAccessState: FileAccessState) {
	pi.registerTool({
		name: "write_file",
		label: "Write File",
		description:
			"Writes content to a specified file in the local filesystem. Creates parent directories when needed. Overwriting an existing file requires a fresh read_file of that same path first.",
		promptSnippet: "Write a file by absolute path, creating parent directories if needed.",
		promptGuidelines: [
			"Use write_file for new files or complete rewrites.",
			"Read an existing file with read_file before overwriting it with write_file.",
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

			const filePath = ensureAbsolutePath(params.file_path, "File path");
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
					fileAccessState.requireFreshRead(filePath, "write_file");
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
				const version = fileAccessState.markMutation(filePath);
				const summary = overwritten ? `Overwrote ${filePath}` : `Created ${filePath}`;

				return {
					content: [{ type: "text", text: diff ? `${summary}\n\n${diff}` : summary }],
					details: {
						path: filePath,
						overwritten,
						diff: diff || undefined,
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
