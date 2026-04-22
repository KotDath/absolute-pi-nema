import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, TextContent } from "@mariozechner/pi-ai";
import { getPiInvocation } from "./pi-spawn.js";
import type { AgentUsage, ExecutionOptions, ExecutionOutcome } from "./types.js";

function emptyUsage(): AgentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
}

function getFinalText(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		for (const content of message.content) {
			if (content.type === "text") {
				return (content as TextContent).text;
			}
		}
	}
	return "";
}

function mergeUsage(usage: AgentUsage, message: Message): AgentUsage {
	const next = { ...usage };
	const rawUsage = (message as Message & { usage?: any }).usage as any;
	if (!rawUsage) {
		return next;
	}
	next.turns += 1;
	next.input += rawUsage.input ?? rawUsage.inputTokens ?? 0;
	next.output += rawUsage.output ?? rawUsage.outputTokens ?? 0;
	next.cacheRead += rawUsage.cacheRead ?? 0;
	next.cacheWrite += rawUsage.cacheWrite ?? 0;
	if (typeof rawUsage.cost === "number") {
		next.cost += rawUsage.cost;
	} else {
		next.cost += rawUsage.cost?.total ?? 0;
	}
	return next;
}

function writePromptFile(systemPrompt: string): { dir: string; filePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "absolute-subagent-prompt-"));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

export async function executeAgentTurn(options: ExecutionOptions): Promise<ExecutionOutcome> {
	const args = ["--mode", "json", "-p", "--session-dir", options.sessionDir];
	if (options.model) {
		args.push("--models", options.model);
	}
	if (options.tools && options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}

	let promptDir: string | undefined;
	if (options.systemPrompt?.trim()) {
		const prompt = writePromptFile(options.systemPrompt.trim());
		promptDir = prompt.dir;
		args.push("--append-system-prompt", prompt.filePath);
	}
	args.push(`Task: ${options.prompt}`);

	const invocation = getPiInvocation(args);
	const messages: Message[] = [];
	let usage = emptyUsage();
	let stopReason: string | undefined;
	let stderr = "";

	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) {
				return;
			}
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						usage = mergeUsage(usage, event.message);
						stopReason = event.message.stopReason;
					}
				}
			} catch {
				// Ignore malformed JSONL chunks from subprocess output.
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("close", (code) => {
			if (buffer.trim()) {
				processLine(buffer);
			}
			resolve(code ?? 0);
		});

		child.on("error", () => {
			resolve(1);
		});
	});

	if (promptDir) {
		try {
			fs.rmSync(promptDir, { recursive: true, force: true });
		} catch {
			// Ignore temp cleanup failures.
		}
	}

	const finalText = getFinalText(messages);
	return {
		exitCode,
		finalText,
		stopReason,
		error: exitCode === 0 ? undefined : stderr.trim() || undefined,
		messages,
		usage,
	};
}
