import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

const MAX_ENTRIES = 100;

const Params = Type.Object({
	path: Type.String({ description: "The absolute path to the directory to list (must be absolute, not relative)" }),
	ignore: Type.Optional(Type.Array(Type.String(), { description: "List of glob patterns to ignore" })),
	file_filtering_options: Type.Optional(
		Type.Object({
			respect_git_ignore: Type.Optional(
				Type.Boolean({ description: "Whether to respect .gitignore patterns. Defaults to true." }),
			),
		}),
	),
});

type Params = Static<typeof Params>;

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

export function registerListDirectory(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_directory",
		label: "List Directory",
		description:
			"Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.",
		promptSnippet: "List files and subdirectories in an absolute directory path.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const dirPath = path.resolve(params.path);

			if (!path.isAbsolute(params.path)) {
				return { content: [{ type: "text", text: `Error: Path must be absolute: ${params.path}` }], details: {} };
			}

			try {
				const stat = fs.statSync(dirPath);
				if (!stat.isDirectory()) {
					return { content: [{ type: "text", text: `Error: Path is not a directory: ${dirPath}` }], details: {} };
				}

				const files = fs.readdirSync(dirPath);
				if (files.length === 0) {
					return { content: [{ type: "text", text: `Directory ${dirPath} is empty.` }], details: {} };
				}

				const entries: { name: string; isDir: boolean }[] = [];
				for (const file of files) {
					if (params.ignore && matchesGlob(file, params.ignore)) {
						continue;
					}
					const fullPath = path.join(dirPath, file);
					try {
						const isDir = fs.statSync(fullPath).isDirectory();
						entries.push({ name: file, isDir });
					} catch {
						// Skip inaccessible entries
					}
				}

				// Sort: directories first, then alphabetically
				entries.sort((a, b) => {
					if (a.isDir && !b.isDir) {
						return -1;
					}
					if (!a.isDir && b.isDir) {
						return 1;
					}
					return a.name.localeCompare(b.name);
				});

				const total = entries.length;
				const truncated = total > MAX_ENTRIES;
				const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

				const listing = shown.map((e) => `${e.isDir ? "[DIR] " : ""}${e.name}`).join("\n");
				let text = `Listed ${total} item(s) in ${dirPath}:\n---\n${listing}`;

				if (truncated) {
					text += `\n---\n[${total - MAX_ENTRIES} items truncated] ...`;
				}

				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error listing directory: ${message}` }], details: {} };
			}
		},
	});
}
