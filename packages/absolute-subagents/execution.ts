import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, TextContent } from "@mariozechner/pi-ai";
import { DEFAULT_TURN_IDLE_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS, TURN_KILL_GRACE_PERIOD_MS } from "./constants.js";
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

function getPartialAssistantText(partial: unknown): string {
	if (!partial || typeof partial !== "object") {
		return "";
	}
	const content = (partial as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	for (let index = content.length - 1; index >= 0; index--) {
		const item = content[index];
		if (item?.type === "text" && typeof item.text === "string") {
			return item.text;
		}
	}
	return "";
}

function getAssistantError(messages: Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as Message & {
			stopReason?: string;
			errorMessage?: string;
		};
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error") {
			return message.errorMessage?.trim() || "Assistant returned an error stop reason.";
		}
	}
	return undefined;
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

function resolveTurnTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs === "number" && timeoutMs > 0) {
		return timeoutMs;
	}
	const envValue = Number(process.env.ABSOLUTE_SUBAGENTS_TURN_TIMEOUT_MS);
	return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_TURN_TIMEOUT_MS;
}

function resolveTurnIdleTimeoutMs(idleTimeoutMs: number | undefined): number {
	if (typeof idleTimeoutMs === "number" && idleTimeoutMs > 0) {
		return idleTimeoutMs;
	}
	const envValue = Number(process.env.ABSOLUTE_SUBAGENTS_TURN_IDLE_TIMEOUT_MS);
	return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_TURN_IDLE_TIMEOUT_MS;
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
	const timeoutMs = resolveTurnTimeoutMs(options.timeoutMs);
	const idleTimeoutMs = resolveTurnIdleTimeoutMs(options.idleTimeoutMs);
	let timeoutError: string | undefined;
	let idleTimeoutError: string | undefined;
	let latestPartialAssistantText = "";

	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let buffer = "";
		let timeoutHandle: NodeJS.Timeout | undefined;
		let killHandle: NodeJS.Timeout | undefined;
		let idleTimeoutHandle: NodeJS.Timeout | undefined;
		let shuttingDown = false;

		const terminateChild = (errorText: string) => {
			if (shuttingDown) {
				return;
			}
			shuttingDown = true;
			if (!timeoutError && !idleTimeoutError) {
				idleTimeoutError = errorText;
			}
			try {
				child.kill("SIGTERM");
			} catch {
				// Ignore kill failures.
			}
			killHandle = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore kill failures.
				}
			}, TURN_KILL_GRACE_PERIOD_MS);
		};

		const resetIdleTimeout = () => {
			if (idleTimeoutHandle) {
				clearTimeout(idleTimeoutHandle);
			}
			idleTimeoutHandle = setTimeout(() => {
				terminateChild(`Subagent turn became idle after ${idleTimeoutMs}ms without output.`);
			}, idleTimeoutMs);
		};

		const processLine = (line: string) => {
			if (!line.trim()) {
				return;
			}
			try {
				const event = JSON.parse(line) as {
					type?: string;
					message?: Message;
					assistantMessageEvent?: { partial?: unknown };
				};
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						usage = mergeUsage(usage, event.message);
						stopReason = event.message.stopReason;
					}
				} else if (event.type === "message_update") {
					const partialText = getPartialAssistantText(event.assistantMessageEvent?.partial);
					if (partialText.trim()) {
						latestPartialAssistantText = partialText;
					}
				}
			} catch {
				// Ignore malformed JSONL chunks from subprocess output.
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			resetIdleTimeout();
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			resetIdleTimeout();
			stderr += chunk.toString("utf8");
		});

		timeoutHandle = setTimeout(() => {
			timeoutError = `Subagent turn timed out after ${timeoutMs}ms.`;
			terminateChild(timeoutError);
		}, timeoutMs);
		resetIdleTimeout();

		child.on("close", (code) => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			if (idleTimeoutHandle) {
				clearTimeout(idleTimeoutHandle);
			}
			if (killHandle) {
				clearTimeout(killHandle);
			}
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

	const finalText = getFinalText(messages) || latestPartialAssistantText;
	const assistantError = getAssistantError(messages);
	const normalizedExitCode =
		exitCode === 0 &&
		!timeoutError &&
		!idleTimeoutError &&
		!assistantError &&
		finalText.trim().length > 0
			? 0
			: 1;
	const error =
		normalizedExitCode === 0
			? undefined
			: timeoutError ||
				idleTimeoutError ||
				assistantError ||
				stderr.trim() ||
				"Subagent completed without a final assistant text response.";
	return {
		exitCode: normalizedExitCode,
		finalText,
		stopReason,
		error,
		messages,
		usage,
	};
}
