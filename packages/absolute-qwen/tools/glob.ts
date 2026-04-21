import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { glob } from "glob";
import { ensureAbsolutePath } from "../lib/path.ts";

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

interface GlobDetails {
	searchDir: string;
	total: number;
	shown: number;
	truncated: boolean;
}

export function registerGlob(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glob",
		label: "Glob",
		description:
			"PURPOSE: Find files by name or path pattern, optionally under a specific absolute directory. Returns absolute matching file paths with recent files first and alphabetical fallback ordering, and reports shown-versus-total when results are truncated.\n" +
			"KEYWORDS: [GlobMatch, FileDiscovery, NamePattern, PathPattern, AbsolutePath, RecentFirst, AlphabeticalFallback, ShownTotal, RefinePattern]",
		promptSnippet: "GlobMatch file-discovery path-pattern shown-total refine-pattern",
		promptGuidelines: ["Pattern-search: use glob instead of shell find when you need files by name or path pattern."],
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<GlobDetails>> {
			const searchDir = params.path ? ensureAbsolutePath(params.path, "Glob path") : ctx.cwd;

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
						details: {
							searchDir,
							total: 0,
							shown: 0,
							truncated: false,
						},
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
				const shownCount = shown.length;

				const fileList = shown.map((e) => String(e)).join("\n");
				let text = `Found ${total} file(s) matching "${params.pattern}" in ${searchDir}. Showing ${shownCount} of ${total}, sorted by modification time (newest first).\n\n${fileList}`;

				if (truncated) {
					text += `\n\n[Showing ${shownCount} of ${total} matches. Narrow the pattern or path to continue.]`;
				}

				return {
					content: [{ type: "text", text }],
					details: { searchDir, total, shown: shownCount, truncated },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Glob search failed: ${message}`);
			}
		},
	});
}
