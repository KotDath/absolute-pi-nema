import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ensureAbsolutePath } from "../lib/path.ts";

const MAX_TOTAL_MATCHES = 40;
const MAX_FILES = 10;
const MAX_MATCHES_PER_FILE = 4;
const MAX_SNIPPET_CHARS = 240;

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
	totalMatches: number;
	shownMatches: number;
	totalFiles: number;
	shownFiles: number;
	truncated: boolean;
}

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	line: string;
}

function parseGrepLine(line: string, basePath: string): GrepMatch | null {
	if (!line.trim()) {
		return null;
	}

	const match = line.match(/^(.*?):(\d+):(.*)$/);
	if (!match) {
		return null;
	}

	const [, rawFilePath, rawLineNumber, rawLine] = match;
	const absolutePath = path.resolve(basePath, rawFilePath);
	return {
		filePath: path.relative(basePath, absolutePath) || path.basename(absolutePath),
		lineNumber: Number(rawLineNumber),
		line: rawLine,
	};
}

function truncateSnippet(line: string) {
	if (line.length <= MAX_SNIPPET_CHARS) {
		return { text: line.trimEnd(), truncated: false };
	}

	return {
		text: `${line.slice(0, MAX_SNIPPET_CHARS).trimEnd()} [snippet truncated at ${MAX_SNIPPET_CHARS} characters]`,
		truncated: true,
	};
}

function formatSummary(details: GrepSearchDetails, pattern: string, displayPath: string) {
	const matchWord = details.totalMatches === 1 ? "match" : "matches";
	const fileWord = details.totalFiles === 1 ? "file" : "files";
	const shownSummary = details.truncated
		? ` Showing ${details.shownMatches} of ${details.totalMatches} ${matchWord} across ${details.shownFiles} of ${details.totalFiles} ${fileWord}.`
		: "";
	return `Found ${details.totalMatches} ${matchWord} for ${JSON.stringify(pattern)} in ${displayPath}.${shownSummary}`;
}

function buildSections(matches: GrepMatch[]) {
	const byFile = new Map<string, GrepMatch[]>();

	for (const match of matches) {
		const existing = byFile.get(match.filePath);
		if (existing) {
			existing.push(match);
			continue;
		}
		byFile.set(match.filePath, [match]);
	}

	const sections: string[] = [];
	let snippetsTruncated = false;
	for (const [filePath, fileMatches] of byFile) {
		sections.push(
			[
				`File: ${filePath}`,
				...fileMatches.map((match) => {
					const snippet = truncateSnippet(match.line);
					snippetsTruncated ||= snippet.truncated;
					return `L${match.lineNumber}: ${snippet.text}`;
				}),
			].join("\n"),
		);
	}

	return {
		text: sections.join("\n\n"),
		snippetsTruncated,
	};
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
			"PURPOSE: Search file contents with regex using bounded, summary-first results. Supports file or directory targets and optional glob filtering. Large searches are kept navigable with capped matches, capped files, and shortened snippets.\n" +
			"KEYWORDS: [RegexSearch, ContentSearch, FileTarget, DirectoryTarget, GlobFilter, SearchFirst, RefineQuery, SummaryFirst, SnippetCap]",
		promptSnippet: "RegexSearch content-search file-target glob-filter refine-query",
		promptGuidelines: [
			"Search-first: use grep_search for regex search instead of grep, rg, or find via bash.",
			"Search-then-read: locate relevant files or lines with grep_search, then use read for nearby context.",
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
			const limit = params.limit === undefined ? MAX_TOTAL_MATCHES : Math.max(1, Math.trunc(params.limit));
			const shownMatchCap = Math.min(limit, MAX_TOTAL_MATCHES);

			return new Promise<AgentToolResult<GrepSearchDetails>>((resolve, reject) => {
				const args = ["-r", "-n", "-H", "-E", "-I"];
				if (params.glob) {
					args.push(`--include=${params.glob}`);
				}
				args.push(params.pattern, searchTarget);
				const child = spawn("grep", args, {
					cwd: baseDir,
					signal,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let stdoutBuffer = "";
				let stderr = "";
				let totalMatches = 0;
				const totalByFile = new Map<string, number>();
				const shownMatches: GrepMatch[] = [];

				const handleLine = (line: string) => {
					const match = parseGrepLine(line, baseDir);
					if (!match) {
						return;
					}

					totalMatches++;
					const fileTotal = (totalByFile.get(match.filePath) ?? 0) + 1;
					totalByFile.set(match.filePath, fileTotal);

					if (shownMatches.length >= shownMatchCap) {
						return;
					}
					if (!totalByFile.has(match.filePath)) {
						return;
					}

					const shownFiles = new Set(shownMatches.map((item) => item.filePath));
					const fileAlreadyShown = shownFiles.has(match.filePath);
					if (!fileAlreadyShown && shownFiles.size >= MAX_FILES) {
						return;
					}

					const shownForFile = shownMatches.filter((item) => item.filePath === match.filePath).length;
					if (shownForFile >= MAX_MATCHES_PER_FILE) {
						return;
					}

					shownMatches.push(match);
				};

				child.stdout.on("data", (chunk: Buffer | string) => {
					stdoutBuffer += chunk.toString();
					let newlineIndex = stdoutBuffer.indexOf("\n");
					while (newlineIndex !== -1) {
						const line = stdoutBuffer.slice(0, newlineIndex);
						stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
						handleLine(line);
						newlineIndex = stdoutBuffer.indexOf("\n");
					}
				});
				child.stderr.on("data", (chunk: Buffer | string) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => {
					if (stdoutBuffer.trim()) {
						handleLine(stdoutBuffer);
					}

					if (code !== 0 && code !== 1) {
						reject(new Error(stderr || `grep exited with code ${code}`));
						return;
					}

					if (totalMatches === 0) {
						resolve({
							content: [
								{ type: "text", text: `No matches found for ${JSON.stringify(params.pattern)} in ${displayPath}.` },
							],
							details: {
								searchPath: displayPath,
								totalMatches: 0,
								shownMatches: 0,
								totalFiles: 0,
								shownFiles: 0,
								truncated: false,
							},
						});
						return;
					}

					const shownFiles = new Set(shownMatches.map((match) => match.filePath)).size;
					const details: GrepSearchDetails = {
						searchPath: displayPath,
						totalMatches,
						shownMatches: shownMatches.length,
						totalFiles: totalByFile.size,
						shownFiles,
						truncated: shownMatches.length < totalMatches || shownFiles < totalByFile.size,
					};
					const sections = buildSections(shownMatches);
					let text = formatSummary(details, params.pattern, displayPath);

					if (sections.text) {
						text += `\n\n${sections.text}`;
					}

					const notes: string[] = [];
					if (details.truncated) {
						notes.push("Refine the pattern, path, or glob to continue.");
					}
					if (sections.snippetsTruncated) {
						notes.push(`Some snippets were truncated at ${MAX_SNIPPET_CHARS} characters.`);
					}
					if (notes.length > 0) {
						text += `\n\n[${notes.join(" ")}]`;
					}

					resolve({
						content: [{ type: "text", text }],
						details,
					});
				});
			});
		},
	});
}
