import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";

const MAX_FILES = 100;

const Params = Type.Object({
	pattern: Type.String({ description: "The glob pattern to match files against" }),
	path: Type.Optional(
		Type.String({
			description: "The directory to search in. If not specified, the current working directory will be used.",
		}),
	),
});

type Params = Static<typeof Params>;

export function registerGlob(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glob",
		label: "Glob",
		description:
			"Fast file pattern matching tool that works with any codebase size\n" +
			'- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
			"- Returns matching file paths sorted by modification time\n" +
			"- Use this tool when you need to find files by name patterns\n" +
			"- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.",
		promptSnippet: "Find files by glob pattern, optionally under a specific directory.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const searchDir = params.path ? path.resolve(params.path) : ctx.cwd;

			try {
				const entries = await glob(params.pattern, {
					cwd: searchDir,
					nodir: true,
					stat: true,
					dot: true,
					follow: false,
					absolute: true,
					signal: signal ?? undefined,
				});

				if (entries.length === 0) {
					return {
						content: [{ type: "text", text: `No files found matching pattern "${params.pattern}" in ${searchDir}` }],
						details: {},
					};
				}

				// Sort by modification time (newest first)
				const oneDayMs = 24 * 60 * 60 * 1000;
				const now = Date.now();

				entries.sort((a, b) => {
					const mtimeA = Number((a as unknown as { mtimeMs?: number }).mtimeMs) || 0;
					const mtimeB = Number((b as unknown as { mtimeMs?: number }).mtimeMs) || 0;
					const aRecent = now - mtimeA < oneDayMs;
					const bRecent = now - mtimeB < oneDayMs;
					if (aRecent && bRecent) {
						return mtimeB - mtimeA;
					}
					if (aRecent) {
						return -1;
					}
					if (bRecent) {
						return 1;
					}
					return String(a).localeCompare(String(b));
				});

				const total = entries.length;
				const truncated = total > MAX_FILES;
				const shown = truncated ? entries.slice(0, MAX_FILES) : entries;

				const fileList = shown.map((e) => String(e)).join("\n");
				let text = `Found ${total} file(s) matching "${params.pattern}" in ${searchDir}, sorted by modification time (newest first):\n---\n${fileList}`;

				if (truncated) {
					text += `\n---\n[${total - MAX_FILES} files truncated] ...`;
				}

				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error during glob search: ${message}` }], details: {} };
			}
		},
	});
}
