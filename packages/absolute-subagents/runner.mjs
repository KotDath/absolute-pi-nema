import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const STOP_POLL_INTERVAL_MS = 100;

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readInbox(inboxPath) {
	try {
		return fs
			.readFileSync(inboxPath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function getPiInvocation(args) {
	const overrideScript = process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT?.trim();
	if (overrideScript) {
		return {
			command: process.execPath,
			args: [overrideScript, ...args],
		};
	}

	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return {
			command: process.execPath,
			args: [currentScript, ...args],
		};
	}

	return { command: "pi", args };
}

function mergeUsage(usage, message) {
	const rawUsage = message?.usage;
	if (!rawUsage) {
		return usage;
	}
	return {
		input: usage.input + (rawUsage.input ?? rawUsage.inputTokens ?? 0),
		output: usage.output + (rawUsage.output ?? rawUsage.outputTokens ?? 0),
		cacheRead: usage.cacheRead + (rawUsage.cacheRead ?? 0),
		cacheWrite: usage.cacheWrite + (rawUsage.cacheWrite ?? 0),
		cost: usage.cost + (typeof rawUsage.cost === "number" ? rawUsage.cost : rawUsage.cost?.total ?? 0),
		turns: usage.turns + 1,
	};
}

function getFinalText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const textBlock = message.content.find((item) => item.type === "text");
		if (textBlock?.text) {
			return textBlock.text;
		}
	}
	return "";
}

function writePromptFile(systemPrompt) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "absolute-subagent-runner-"));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

async function executeTurn(config, envelope) {
	const args = ["--mode", "json", "-p", "--session-dir", config.sessionDir];
	if (config.model) {
		args.push("--models", config.model);
	}
	if (config.tools?.length) {
		args.push("--tools", config.tools.join(","));
	}

	let promptDir;
	if (config.systemPrompt?.trim()) {
		promptDir = writePromptFile(config.systemPrompt.trim());
		args.push("--append-system-prompt", promptDir.filePath);
	}
	args.push(`Task: ${envelope.content}`);
	const invocation = getPiInvocation(args);
	const messages = [];
	let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let stopReason;
	let stderr = "";

	const child = spawn(invocation.command, invocation.args, {
		cwd: config.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	let buffer = "";
	let stopInterval;

	const exitCode = await new Promise((resolve) => {
		const processLine = (line) => {
			if (!line.trim()) {
				return;
			}
			try {
				const event = JSON.parse(line);
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						usage = mergeUsage(usage, event.message);
						stopReason = event.message.stopReason;
					}
				}
			} catch {
				// Ignore malformed JSON lines.
			}
		};

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});

		stopInterval = setInterval(() => {
			const state = readJson(config.statePath);
			if (state?.stopRequested) {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
		}, STOP_POLL_INTERVAL_MS);

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

	if (stopInterval) {
		clearInterval(stopInterval);
	}
	if (promptDir) {
		try {
			fs.rmSync(promptDir.dir, { recursive: true, force: true });
		} catch {}
	}

	return {
		exitCode,
		finalText: getFinalText(messages),
		stopReason,
		error: exitCode === 0 ? undefined : stderr.trim() || undefined,
		messages,
		usage,
	};
}

export async function runConfig(configPath) {
	const config = readJson(configPath);
	if (!config) {
		throw new Error(`Missing config: ${configPath}`);
	}

	while (true) {
		const currentState = readJson(config.statePath);
		if (!currentState) {
			throw new Error(`Missing state file: ${config.statePath}`);
		}
		if (currentState.stopRequested || currentState.status === "stopped") {
			const stoppedState = {
				...currentState,
				status: "stopped",
				endedAt: currentState.endedAt ?? Date.now(),
				updatedAt: Date.now(),
			};
			writeJson(config.statePath, stoppedState);
			appendJsonl(config.eventsPath, { type: "run.stopped", ts: Date.now(), runId: currentState.id });
			return stoppedState;
		}

		const inbox = readInbox(config.inboxPath);
		const envelope = inbox[currentState.nextMessageIndex];
		if (!envelope) {
			const completedState = {
				...currentState,
				status: currentState.status === "failed" ? "failed" : "completed",
				endedAt: currentState.endedAt ?? Date.now(),
				updatedAt: Date.now(),
				pid: undefined,
			};
			writeJson(config.statePath, completedState);
			appendJsonl(config.eventsPath, { type: "run.idle", ts: Date.now(), runId: currentState.id });
			return completedState;
		}

		const startedAt = Date.now();
		const runningState = {
			...currentState,
			status: "running",
			startedAt: currentState.startedAt ?? startedAt,
			updatedAt: startedAt,
			pid: process.pid,
		};
		writeJson(config.statePath, runningState);
		appendJsonl(config.eventsPath, {
			type: "turn.started",
			ts: startedAt,
			runId: currentState.id,
			messageId: envelope.id,
		});

		const turn = await executeTurn(config, envelope);
		const endedAt = Date.now();
		const previousResult =
			readJson(config.resultPath) ?? {
				id: config.id,
				agent: config.agent,
				mode: "background",
				status: "completed",
				sessionDir: config.sessionDir,
				turns: [],
				finalText: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			};
		const nextResult = {
			...previousResult,
			status: turn.exitCode === 0 ? "completed" : "failed",
			turns: [
				...previousResult.turns,
				{
					messageId: envelope.id,
					prompt: envelope.content,
					exitCode: turn.exitCode,
					finalText: turn.finalText,
					startedAt,
					endedAt,
					stopReason: turn.stopReason,
					error: turn.error,
					messages: turn.messages,
					usage: turn.usage,
				},
			],
			finalText: turn.finalText,
			usage: {
				input: previousResult.usage.input + turn.usage.input,
				output: previousResult.usage.output + turn.usage.output,
				cacheRead: previousResult.usage.cacheRead + turn.usage.cacheRead,
				cacheWrite: previousResult.usage.cacheWrite + turn.usage.cacheWrite,
				cost: previousResult.usage.cost + turn.usage.cost,
				turns: previousResult.usage.turns + turn.usage.turns,
			},
			error: turn.error,
		};
		writeJson(config.resultPath, nextResult);

		const latestState = readJson(config.statePath) ?? runningState;
		const turnStatus = latestState.stopRequested ? "stopped" : turn.exitCode === 0 ? "completed" : "failed";
		const nextState = {
			...latestState,
			status: turnStatus,
			nextMessageIndex: latestState.nextMessageIndex + 1,
			updatedAt: endedAt,
			endedAt,
			lastError: turn.error,
			pid: undefined,
		};
		writeJson(config.statePath, nextState);
		appendJsonl(config.eventsPath, {
			type: "turn.completed",
			ts: endedAt,
			runId: currentState.id,
			messageId: envelope.id,
			status: turnStatus,
			exitCode: turn.exitCode,
		});

		if (turnStatus === "failed" || turnStatus === "stopped") {
			return nextState;
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const configPath = process.argv[2];
	runConfig(configPath).catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exit(1);
	});
}

