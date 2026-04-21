import fs from "node:fs/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ensureAbsolutePath } from "../lib/path.ts";

const MAX_ENTRIES = 100;

const Params = Type.Object(
	{
		path: Type.String({ description: "The absolute path to the directory to list." }),
		ignore: Type.Optional(Type.Array(Type.String(), { description: "Glob-like filename patterns to ignore." })),
	},
	{ additionalProperties: false },
);

type Params = Static<typeof Params>;

interface ListDirectoryDetails {
	path: string;
	total: number;
	shown: number;
	truncated: boolean;
}

function matchesGlob(filename: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		const regexStr = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");
		if (new RegExp(`^${regexStr}$`).test(filename)) {
			return true;
		}
	}
	return false;
}

function prepareArguments(args: unknown): Params {
	if (!args || typeof args !== "object") {
		return args as Params;
	}

	const { file_filtering_options: _unused, ...rest } = args as Record<string, unknown>;
	return rest as Params;
}

export function registerListDirectory(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_directory",
		label: "List Directory",
		description:
			"PURPOSE: List files and direct subdirectories inside an absolute directory path. Output is deterministic: directories first, then files, both sorted alphabetically.\n" +
			"KEYWORDS: [DirectoryList, AbsolutePath, DeterministicOrder, DirectChildren, IgnorePatterns, ShownTotal]",
		promptSnippet: "DirectoryList absolute-path direct-children shown-total",
		promptGuidelines: ["Direct-inspection: use list_directory instead of shell ls/find for directory inspection."],
		parameters: Params,
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<ListDirectoryDetails>> {
			const dirPath = ensureAbsolutePath(params.path, "Directory path");
			const stat = await fs.stat(dirPath);
			if (!stat.isDirectory()) {
				throw new Error(`Path is not a directory: ${dirPath}`);
			}

			const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
			const filtered = dirEntries
				.filter((entry) => !(params.ignore && matchesGlob(entry.name, params.ignore)))
				.map((entry) => ({
					name: entry.name,
					isDir: entry.isDirectory(),
				}))
				.sort((a, b) => {
					if (a.isDir !== b.isDir) {
						return a.isDir ? -1 : 1;
					}
					return a.name.localeCompare(b.name);
				});

			if (filtered.length === 0) {
				return {
					content: [{ type: "text", text: `Directory ${dirPath} is empty.` }],
					details: {
						path: dirPath,
						total: 0,
						shown: 0,
						truncated: false,
					},
				};
			}

			const truncated = filtered.length > MAX_ENTRIES;
			const visible = truncated ? filtered.slice(0, MAX_ENTRIES) : filtered;
			const shown = visible.length;
			const listing = visible.map((entry) => `${entry.isDir ? "[DIR] " : ""}${entry.name}`).join("\n");
			let text = `Listed ${filtered.length} item(s) in ${dirPath}. Showing ${shown} of ${filtered.length}.\n\n${listing}`;
			if (truncated) {
				text += `\n\n[Showing ${shown} of ${filtered.length} entries. Narrow the path or ignore patterns to continue.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					path: dirPath,
					total: filtered.length,
					shown,
					truncated,
				},
			};
		},
	});
}
