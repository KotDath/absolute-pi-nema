import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

const Params = Type.Object({
	pattern: Type.String({ description: "The regular expression pattern to search for in file contents" }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search in. Defaults to current working directory." }),
	),
	glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' })),
	limit: Type.Optional(
		Type.Number({
			description: "Limit output to first N matching lines. Optional - shows all matches if not specified.",
		}),
	),
});

type Params = Static<typeof Params>;

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	line: string;
}

function parseGrepOutput(output: string, basePath: string): GrepMatch[] {
	const results: GrepMatch[] = [];
	if (!output) {
		return results;
	}

	for (const line of output.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		const firstColon = line.indexOf(":");
		if (firstColon === -1) {
			continue;
		}
		const secondColon = line.indexOf(":", firstColon + 1);
		if (secondColon === -1) {
			continue;
		}

		const filePathRaw = line.substring(0, firstColon);
		const lineNumberStr = line.substring(firstColon + 1, secondColon);
		const lineContent = line.substring(secondColon + 1);
		const lineNumber = parseInt(lineNumberStr, 10);

		if (!Number.isNaN(lineNumber)) {
			const absolutePath = path.resolve(basePath, filePathRaw);
			const relativePath = path.relative(basePath, absolutePath);
			results.push({ filePath: relativePath || path.basename(absolutePath), lineNumber, line: lineContent });
		}
	}
	return results;
}

export function registerGrepSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "grep_search",
		label: "Grep Search",
		description:
			"A powerful search tool for finding patterns in files\n\n" +
			"  Usage:\n" +
			"  - ALWAYS use grep_search for search tasks. NEVER invoke `grep` or `rg` as a shell command.\n" +
			'  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n' +
			'  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx")\n' +
			"  - Case-insensitive by default",
		promptSnippet: "Search file contents with regex, optional path filter, and optional glob.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const searchDir = params.path ? path.resolve(params.path) : ctx.cwd;
			const filterDesc = params.glob ? ` (filter: "${params.glob}")` : "";

			try {
				// Validate regex
				new RegExp(params.pattern);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error: Invalid regular expression pattern: ${params.pattern}. ${message}` }],
					details: {},
				};
			}

			return new Promise<AgentToolResult<unknown>>((resolve) => {
				const args = ["-r", "-n", "-H", "-E", "-I"];
				if (params.glob) {
					args.push(`--include=${params.glob}`);
				}
				args.push(params.pattern, searchDir);

				execFile(
					"grep",
					args,
					{ cwd: searchDir, maxBuffer: 10 * 1024 * 1024 },
					(error: Error | null, stdout: string, stderr: string) => {
						if (error && (error as unknown as { code?: number }).code !== 1) {
							// code 1 = no matches, that's fine
							const output = stderr || error.message;
							resolve({ content: [{ type: "text", text: `Error during grep: ${output}` }], details: {} });
							return;
						}

						const matches = parseGrepOutput(stdout, searchDir);

						if (matches.length === 0) {
							resolve({
								content: [
									{
										type: "text",
										text: `No matches found for pattern "${params.pattern}" in ${searchDir}${filterDesc}.`,
									},
								],
								details: {},
							});
							return;
						}

						// Apply limit
						let truncated = false;
						let shown = matches;
						if (params.limit && matches.length > params.limit) {
							shown = matches.slice(0, params.limit);
							truncated = true;
						}

						// Group by file
						const byFile = new Map<string, GrepMatch[]>();
						for (const m of shown) {
							const existing = byFile.get(m.filePath);
							if (existing) {
								existing.push(m);
							} else {
								byFile.set(m.filePath, [m]);
							}
						}

						let text = `Found ${matches.length} matches for pattern "${params.pattern}" in ${searchDir}${filterDesc}:\n---\n`;
						for (const [filePath, fileMatches] of byFile) {
							text += `File: ${filePath}\n`;
							for (const m of fileMatches) {
								text += `L${m.lineNumber}: ${m.line.trim()}\n`;
							}
							text += "---\n";
						}

						if (truncated) {
							text += `[${matches.length - shown.length} lines truncated] ...`;
						}

						resolve({ content: [{ type: "text", text }], details: {} });
					},
				);
			});
		},
	});
}
