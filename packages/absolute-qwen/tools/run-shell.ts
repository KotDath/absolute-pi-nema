import { spawn } from "node:child_process";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { resolveWorkingDirectory } from "../lib/path.ts";
import { truncateOutput } from "../lib/truncate.ts";

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

interface RunShellDetails {
	cwd: string;
	exitCode?: number | null;
	pid?: number;
	background: boolean;
	timedOut?: boolean;
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

export function registerRunShell(pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_shell_command",
		label: "Run Shell Command",
		description:
			"Executes a bash command via `bash -lc` in the current project or a specified directory. Supports foreground execution with timeout/abort handling and detached background launch for long-running processes.\n\n" +
			"IMPORTANT: Use specialized tools for reading, writing, editing, listing, globbing, and grep-style search. This tool is for terminal operations such as git, package managers, build systems, test runners, and process control.",
		promptSnippet: "Run a shell command in the project or a specified directory.",
		promptGuidelines: [
			"Use run_shell_command for terminal workflows such as git, tests, builds, and package managers.",
			"Do not use run_shell_command for file reads, file edits, directory listing, globbing, or grep-style search when a specialized tool exists.",
		],
		parameters: Params,
		prepareArguments,
		async execute(
			_toolCallId: string,
			params: Params,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<RunShellDetails>> {
			const timeout = Math.min(Math.max(1, Math.trunc(params.timeout ?? 120_000)), 600_000);
			const cwd = resolveWorkingDirectory(params.directory, ctx.cwd);

			if (params.is_background) {
				const child = spawn("bash", ["-lc", params.command], {
					cwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();

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
					},
				};
			}

			return new Promise<AgentToolResult<RunShellDetails>>((resolve, reject) => {
				const child = spawn("bash", ["-lc", params.command], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let stdout = "";
				let stderr = "";
				let timedOut = false;
				let finished = false;

				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeout);

				const abortListener = () => {
					child.kill("SIGTERM");
					reject(new Error("Command aborted"));
				};

				signal?.addEventListener("abort", abortListener, { once: true });

				child.stdout.on("data", (chunk: Buffer | string) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk: Buffer | string) => {
					stderr += chunk.toString();
				});
				child.on("error", (error) => {
					if (finished) {
						return;
					}
					finished = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", abortListener);
					reject(error);
				});
				child.on("close", (code) => {
					if (finished) {
						return;
					}
					finished = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", abortListener);

					const output = truncateOutput([stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : ""));
					if (timedOut) {
						reject(new Error(output ? `${output}\n[Timed out after ${timeout}ms]` : `Timed out after ${timeout}ms`));
						return;
					}
					if (code !== 0) {
						reject(new Error(output ? `${output}\n[Exit code: ${code}]` : `Command failed with exit code ${code}`));
						return;
					}

					resolve({
						content: [{ type: "text", text: output || "Command completed with no output." }],
						details: {
							cwd,
							exitCode: code,
							background: false,
						},
					});
				});
			});
		},
	});
}
