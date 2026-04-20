import { type ExecFileException, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ensureAbsolutePath } from "../lib/path.ts";

const Params = Type.Object(
	{
		pattern: Type.String({ description: "The regular expression pattern to search for in file contents." }),
		path: Type.Optional(
			Type.String({
				description: "Absolute file or directory to search in. Defaults to the current working directory.",
			}),
		),
		glob: Type.Optional(Type.String({ description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}").' })),
		limit: Type.Optional(
			Type.Number({
				description: "Limit output to the first N matching lines.",
			}),
		),
	},
	{ additionalProperties: false },
);

type Params = Static<typeof Params>;

interface GrepSearchDetails {
	searchPath: string;
	matchCount: number;
	limited: boolean;
}

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	line: string;
}

function parseGrepOutput(output: string, basePath: string): GrepMatch[] {
	const results: GrepMatch[] = [];

	for (const line of output.split("\n")) {
		if (!line.trim()) {
			continue;
		}

		const match = line.match(/^(.*?):(\d+):(.*)$/);
		if (!match) {
			continue;
		}

		const [, rawFilePath, rawLineNumber, rawLine] = match;
		const absolutePath = path.resolve(basePath, rawFilePath);
		results.push({
			filePath: path.relative(basePath, absolutePath) || path.basename(absolutePath),
			lineNumber: Number(rawLineNumber),
			line: rawLine,
		});
	}

	return results;
}

function prepareSearchTarget(targetPath: string | undefined, cwd: string) {
	if (!targetPath) {
		return {
			baseDir: cwd,
			searchTarget: ".",
			displayPath: cwd,
		};
	}

	const absolutePath = ensureAbsolutePath(targetPath, "Search path");
	return fs.stat(absolutePath).then((stat) => {
		if (stat.isDirectory()) {
			return {
				baseDir: absolutePath,
				searchTarget: ".",
				displayPath: absolutePath,
			};
		}
		if (stat.isFile()) {
			return {
				baseDir: path.dirname(absolutePath),
				searchTarget: path.basename(absolutePath),
				displayPath: absolutePath,
			};
		}
		throw new Error(`Search path is neither a file nor a directory: ${absolutePath}`);
	});
}

export function registerGrepSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "grep_search",
		label: "Grep Search",
		description:
			"A regex search tool for file contents. Supports file or directory targets and optional glob filtering. Use this instead of invoking grep or rg via the shell for content search tasks.",
		promptSnippet: "Search file contents with regex, optional absolute path filter, and optional glob.",
		promptGuidelines: [
			"Use grep_search for regex search tasks instead of invoking grep, rg, or find via run_shell_command.",
		],
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<GrepSearchDetails>> {
			try {
				new RegExp(params.pattern);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Invalid regular expression pattern ${JSON.stringify(params.pattern)}: ${message}`);
			}

			const { baseDir, searchTarget, displayPath } = await prepareSearchTarget(params.path, ctx.cwd);
			const limit = params.limit === undefined ? undefined : Math.max(1, Math.trunc(params.limit));

			return new Promise<AgentToolResult<GrepSearchDetails>>((resolve, reject) => {
				const args = ["-r", "-n", "-H", "-E", "-I"];
				if (params.glob) {
					args.push(`--include=${params.glob}`);
				}
				args.push(params.pattern, searchTarget);

				execFile(
					"grep",
					args,
					{ cwd: baseDir, maxBuffer: 10 * 1024 * 1024, signal, encoding: "utf8" },
					(error: ExecFileException | null, stdout: string, stderr: string) => {
						const exitCode = typeof error?.code === "number" ? error.code : undefined;
						if (error && exitCode !== 1) {
							reject(new Error(stderr || error.message));
							return;
						}

						const matches = parseGrepOutput(stdout, baseDir);
						if (matches.length === 0) {
							resolve({
								content: [
									{ type: "text", text: `No matches found for ${JSON.stringify(params.pattern)} in ${displayPath}.` },
								],
								details: {
									searchPath: displayPath,
									matchCount: 0,
									limited: false,
								},
							});
							return;
						}

						const limitedMatches = limit && matches.length > limit ? matches.slice(0, limit) : matches;
						const limited = limitedMatches.length !== matches.length;
						const byFile = new Map<string, GrepMatch[]>();

						for (const match of limitedMatches) {
							const existing = byFile.get(match.filePath);
							if (existing) {
								existing.push(match);
							} else {
								byFile.set(match.filePath, [match]);
							}
						}

						const sections: string[] = [];
						for (const [filePath, fileMatches] of byFile) {
							sections.push(
								[
									`File: ${filePath}`,
									...fileMatches.map((match) => `L${match.lineNumber}: ${match.line.trimEnd()}`),
								].join("\n"),
							);
						}

						let text = `Found ${matches.length} match(es) for ${JSON.stringify(params.pattern)} in ${displayPath}.\n\n${sections.join("\n\n")}`;
						if (limited) {
							text += `\n\n[Showing first ${limitedMatches.length} match(es). Refine the pattern or path to continue.]`;
						}

						resolve({
							content: [{ type: "text", text }],
							details: {
								searchPath: displayPath,
								matchCount: matches.length,
								limited,
							},
						});
					},
				);
			});
		},
	});
}
