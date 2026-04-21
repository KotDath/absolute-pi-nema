import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { FileAccessState } from "../lib/file-access-state.ts";
import { resolveWorkingDirectory } from "../lib/path.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const SPOOL_THRESHOLD_BYTES = 8 * 1024;
const MAX_TAIL_LINES = 80;
const MAX_TAIL_CHARS = 16 * 1024;

const Params = Type.Object(
	{
		command: Type.String({ description: "The bash command to execute." }),
		is_background: Type.Boolean({
			description:
				"Whether to run the command in the background. Use true for long-running processes like dev servers.",
		}),
		timeout: Type.Optional(
			Type.Number({
				description: "Optional timeout in milliseconds (max 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
			}),
		),
		description: Type.Optional(
			Type.String({ description: "Clear, concise description of what this command does in 5-10 words." }),
		),
		directory: Type.Optional(
			Type.String({
				description: "Optional working directory. Relative directories resolve from the current session cwd.",
			}),
		),
	},
	{ additionalProperties: false },
);

type Params = Static<typeof Params>;

interface TailSummary {
	content: string;
	truncated: boolean;
	totalLines: number;
	outputLines: number;
}

interface RunShellDetails {
	cwd: string;
	exitCode?: number | null;
	pid?: number;
	background: boolean;
	timedOut?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
	totalLines?: number;
	outputLines?: number;
	startedAt?: number;
	endedAt?: number;
}

function prepareArguments(args: unknown): Params {
	if (!args || typeof args !== "object") {
		return args as Params;
	}

	const input = args as { cwd?: unknown; directory?: unknown };
	if (typeof input.directory === "string" || typeof input.cwd !== "string") {
		return args as Params;
	}

	return {
		...(args as Params),
		directory: input.cwd,
	};
}

function getTempLogPath() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "apb-shell-"));
	return path.join(dir, "command.log");
}

function truncateTail(text: string): TailSummary {
	if (!text) {
		return {
			content: "",
			truncated: false,
			totalLines: 0,
			outputLines: 0,
		};
	}

	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const totalLines = lines.length;
	let visibleLines = lines.slice(-MAX_TAIL_LINES);
	let truncated = visibleLines.length < lines.length;
	let content = visibleLines.join("\n");

	if (content.length > MAX_TAIL_CHARS) {
		truncated = true;
		content = content.slice(-MAX_TAIL_CHARS);
		const newlineIndex = content.indexOf("\n");
		if (newlineIndex !== -1 && newlineIndex < content.length - 1) {
			content = content.slice(newlineIndex + 1);
		}
		visibleLines = content.split("\n");
	}

	return {
		content,
		truncated,
		totalLines,
		outputLines: content ? visibleLines.length : 0,
	};
}

function buildFinalText(
	tail: TailSummary,
	fullOutputPath: string | undefined,
	status: "success" | "error" | "timeout" | "aborted",
	exitCode: number | null | undefined,
	timeoutMs: number,
) {
	let text = tail.content || "Command completed with no output.";

	if (tail.truncated && fullOutputPath) {
		text += `\n\n[Showing last ${tail.outputLines} of ${tail.totalLines} line(s). Full output: ${fullOutputPath}]`;
	}

	if (status === "success") {
		if (tail.truncated) {
			text += "\n\n[Command completed successfully.]";
		}
		return text;
	}
	if (status === "timeout") {
		text += `\n\n[Timed out after ${timeoutMs}ms${fullOutputPath ? `. Full output: ${fullOutputPath}` : ""}]`;
		return text;
	}
	if (status === "aborted") {
		text += fullOutputPath ? `\n\n[Command aborted. Full output: ${fullOutputPath}]` : "\n\n[Command aborted]";
		return text;
	}

	text += `\n\n[Exit code: ${exitCode ?? "unknown"}${fullOutputPath ? `. Full output: ${fullOutputPath}` : ""}]`;
	return text;
}

export function registerRunShell(pi: ExtensionAPI, fileAccessState: FileAccessState) {
	pi.registerTool({
		name: "run_shell_command",
		label: "Run Shell Command",
		description:
			"PURPOSE: Execute a bash command via `bash -lc` in the current project or a specified directory. Foreground commands stream live output updates, keep the latest tail in the model context, and save the full log to a temp file when output grows large. Background mode is a detached best-effort launch for long-running processes.\n" +
			"KEYWORDS: [ShellExec, Build, Test, Git, PackageManager, StreamOutput, TailOutput, FullLog, BackgroundLaunch, NoFileRead, NoGrep]\n\n" +
			"IMPORTANT: Use specialized tools for reading, writing, editing, listing, globbing, and grep-style search. This tool is for terminal operations such as git, package managers, build systems, test runners, and process control.",
		promptSnippet: "ShellExec build test git stream-output full-log",
		promptGuidelines: [
			"Terminal-workflows only: use run_shell_command for git, tests, builds, package managers, and process control.",
			"No file-read/search fallback: do not use run_shell_command for file reads, edits, directory listing, globbing, or grep-style search when a specialized tool exists.",
		],
		parameters: Params,
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<RunShellDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<RunShellDetails>> {
			const timeout = Math.min(Math.max(1, Math.trunc(params.timeout ?? DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS);
			const cwd = resolveWorkingDirectory(params.directory, ctx.cwd);
			const startedAt = Date.now();

			if (params.is_background) {
				const child = spawn("bash", ["-lc", params.command], {
					cwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();
				fileAccessState.invalidateAllReads();

				return {
					content: [
						{
							type: "text",
							text: `Started background command (PID ${child.pid ?? "unknown"}) in ${cwd}\n${params.command}`,
						},
					],
					details: {
						cwd,
						pid: child.pid,
						background: true,
						startedAt,
					},
				};
			}

			return new Promise<AgentToolResult<RunShellDetails>>((resolve, reject) => {
				const operations = createLocalBashOperations();

				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunkBytes = MAX_TAIL_CHARS * 2;
				let finished = false;

				const ensureTempFile = () => {
					if (tempFilePath) {
						return;
					}
					tempFilePath = getTempLogPath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) {
						tempFileStream.write(chunk);
					}
				};

				const closeTempFile = (callback: () => void) => {
					if (!tempFileStream) {
						callback();
						return;
					}
					tempFileStream.end(() => callback());
				};

				const emitUpdate = () => {
					if (!onUpdate) {
						return;
					}

					const tail = truncateTail(Buffer.concat(chunks).toString("utf8"));
					if (tail.truncated) {
						ensureTempFile();
					}
					onUpdate({
						content: tail.content ? [{ type: "text", text: tail.content }] : [],
						details: {
							cwd,
							background: false,
							truncated: tail.truncated,
							fullOutputPath: tempFilePath,
							totalLines: tail.totalLines,
							outputLines: tail.outputLines,
							startedAt,
						},
					});
				};

				const handleData = (chunk: Buffer | string) => {
					const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					totalBytes += data.length;
					if (totalBytes > SPOOL_THRESHOLD_BYTES) {
						ensureTempFile();
					}
					if (tempFileStream) {
						tempFileStream.write(data);
					}
					chunks.push(data);
					chunksBytes += data.length;
					while (chunksBytes > maxChunkBytes && chunks.length > 1) {
						const removed = chunks.shift();
						if (!removed) {
							break;
						}
						chunksBytes -= removed.length;
					}
					emitUpdate();
				};

				const finalize = (
					status: "success" | "error" | "timeout" | "aborted",
					exitCode?: number | null,
					invalidateReads: boolean = true,
				) => {
					if (finished) {
						return;
					}
					finished = true;

					const tail = truncateTail(Buffer.concat(chunks).toString("utf8"));
					if (tail.truncated) {
						ensureTempFile();
					}
					const endedAt = Date.now();
					if (invalidateReads) {
						fileAccessState.invalidateAllReads();
					}

					closeTempFile(() => {
						const text = buildFinalText(tail, tempFilePath, status, exitCode, timeout);
						const details: RunShellDetails = {
							cwd,
							exitCode,
							background: false,
							timedOut: status === "timeout",
							truncated: tail.truncated,
							fullOutputPath: tempFilePath,
							totalLines: tail.totalLines,
							outputLines: tail.outputLines,
							startedAt,
							endedAt,
						};

						if (status === "success") {
							resolve({
								content: [{ type: "text", text }],
								details,
							});
							return;
						}

						reject(new Error(text));
					});
				};
				onUpdate?.({
					content: [],
					details: {
						cwd,
						background: false,
						startedAt,
					},
				});

				void operations
					.exec(params.command, cwd, {
						onData: handleData,
						signal,
						timeout: timeout / 1000,
					})
					.then(({ exitCode }) => {
						if (exitCode !== 0) {
							finalize("error", exitCode);
							return;
						}
						finalize("success", exitCode);
					})
					.catch((error) => {
						if (finished) {
							return;
						}
						if (error instanceof Error) {
							if (error.message === "aborted") {
								finalize("aborted", null);
								return;
							}
							if (error.message.startsWith("timeout:")) {
								finalize("timeout", null);
								return;
							}
						}
						finished = true;
						closeTempFile(() => reject(error));
					});
			});
		},
	});
}
