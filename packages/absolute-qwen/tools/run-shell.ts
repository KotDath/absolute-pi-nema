import { exec } from "node:child_process";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { truncateOutput } from "../lib/truncate.ts";

const Params = Type.Object({
	command: Type.String({ description: "The bash command to execute." }),
	is_background: Type.Boolean({
		description: "Whether to run the command in the background. Use true for long-running processes like dev servers.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Optional timeout in milliseconds (max 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "Clear, concise description of what this command does in 5-10 words." }),
	),
	directory: Type.Optional(Type.String({ description: "The working directory where the command should be executed." })),
});

type Params = Static<typeof Params>;

export function registerRunShell(pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_shell_command",
		label: "Run Shell Command",
		description:
			"Executes a given shell command (as `bash -c <command>`) in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\n" +
			"IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\n" +
			"**Usage notes**:\n" +
			"- The command argument is required.\n" +
			"- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n" +
			"- It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n\n" +
			"**Background vs Foreground Execution:**\n" +
			"- Use background execution (is_background: true) for: dev servers, build watchers, database servers, web servers, any command expected to run indefinitely.\n" +
			"- Use foreground execution (is_background: false) for: one-time commands, builds, installations, git operations, test runs.",
		promptSnippet: "Run a shell command in the project or a specified directory.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const timeout = Math.min(params.timeout ?? 120_000, 600_000);
			const cwd = params.directory ? path.resolve(params.directory) : _ctx.cwd;

			if (params.is_background) {
				const child = exec(params.command, {
					cwd,
					timeout: undefined, // no timeout for background
					maxBuffer: 10 * 1024 * 1024,
				});

				const pid = child.pid;
				const output = `Background process started (PID: ${pid})\nCommand: ${params.command}\nWorking directory: ${cwd}\n`;

				return { content: [{ type: "text", text: output }], details: { pid, background: true } };
			}

			return new Promise<AgentToolResult<unknown>>((resolve) => {
				exec(params.command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
					let text = "";

					if (stdout) {
						text += stdout;
					}
					if (stderr) {
						if (text) {
							text += "\n";
						}
						text += stderr;
					}

					if (error) {
						if (text) {
							text += "\n";
						}
						if (error.killed) {
							text += `[Process timed out after ${timeout}ms]`;
						} else {
							text += `[Exit code: ${error.code ?? "unknown"}]`;
						}
					}

					text = truncateOutput(text);
					resolve({ content: [{ type: "text", text }], details: {} });
				});
			});
		},
	});
}
