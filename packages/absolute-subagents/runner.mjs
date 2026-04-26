import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const STOP_POLL_INTERVAL_MS = 100;
const ENV_PATH_SEPARATOR = process.platform === "win32" ? ";" : ":";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 180_000;
const TURN_KILL_GRACE_PERIOD_MS = 2_000;

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

function appendLine(filePath, line) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, line, "utf8");
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

	return { command: "pi", args };
}

function buildPiChildEnv() {
	const env = { ...process.env };
	delete env.ABSOLUTE_PLAN_AUTOENTER;
	delete env.ABSOLUTE_PLAN_AUTOENTER_PATH;
	return env;
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

function getPartialAssistantText(partial) {
	if (!partial || typeof partial !== "object" || !Array.isArray(partial.content)) {
		return "";
	}
	for (let index = partial.content.length - 1; index >= 0; index -= 1) {
		const item = partial.content[index];
		if (item?.type === "text" && typeof item.text === "string") {
			return item.text;
		}
	}
	return "";
}

function getAssistantError(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error") {
			return message.errorMessage?.trim() || "Assistant returned an error stop reason.";
		}
	}
	return undefined;
}

function writePromptFile(systemPrompt) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "absolute-subagent-runner-"));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function resolveTurnTimeoutMs(timeoutMs) {
	if (typeof timeoutMs === "number" && timeoutMs > 0) {
		return timeoutMs;
	}
	const envValue = Number(process.env.ABSOLUTE_SUBAGENTS_TURN_TIMEOUT_MS);
	return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_TURN_TIMEOUT_MS;
}

function resolveTurnIdleTimeoutMs(idleTimeoutMs) {
	if (typeof idleTimeoutMs === "number" && idleTimeoutMs > 0) {
		return idleTimeoutMs;
	}
	const envValue = Number(process.env.ABSOLUTE_SUBAGENTS_TURN_IDLE_TIMEOUT_MS);
	return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_TURN_IDLE_TIMEOUT_MS;
}

async function executeTurn(config, envelope) {
	const args = ["--mode", "json", "-p", "--session-dir", config.sessionDir];
	const extensionPaths = process.env.ABSOLUTE_SUBAGENTS_EXTENSION_PATHS?.split(ENV_PATH_SEPARATOR)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (extensionPaths?.length) {
		args.unshift("--no-extensions");
		for (let index = extensionPaths.length - 1; index >= 0; index -= 1) {
			args.unshift(extensionPaths[index]);
			args.unshift("--extension");
		}
	}
	if (process.env.ABSOLUTE_SUBAGENTS_OFFLINE === "1") {
		args.unshift("--offline");
	}
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
	const tracePath = config.tracePath;
	const stderrPath = config.stderrPath;
	const timeoutMs = resolveTurnTimeoutMs(config.timeoutMs);
	const idleTimeoutMs = resolveTurnIdleTimeoutMs(config.idleTimeoutMs);
	let timeoutError;
	let idleTimeoutError;
	let latestPartialAssistantText = "";

	const child = spawn(invocation.command, invocation.args, {
		cwd: config.cwd,
		env: buildPiChildEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	let buffer = "";
	let stopInterval;
	let timeoutHandle;
	let killHandle;
	let idleTimeoutHandle;
	let shuttingDown = false;

	const exitCode = await new Promise((resolve) => {
		const terminateChild = (errorText) => {
			if (shuttingDown) {
				return;
			}
			shuttingDown = true;
			if (!timeoutError && !idleTimeoutError) {
				idleTimeoutError = errorText;
			}
			try {
				child.kill("SIGTERM");
			} catch {}
			killHandle = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
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
				} else if (event.type === "message_update") {
					const partialText = getPartialAssistantText(event.assistantMessageEvent?.partial);
					if (partialText.trim()) {
						latestPartialAssistantText = partialText;
					}
				}
			} catch {
				// Ignore malformed JSON lines.
			}
		};

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			resetIdleTimeout();
			if (tracePath) {
				appendLine(tracePath, text);
			}
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			resetIdleTimeout();
			stderr += text;
			if (stderrPath) {
				appendLine(stderrPath, text);
			}
		});

		timeoutHandle = setTimeout(() => {
			timeoutError = `Subagent turn timed out after ${timeoutMs}ms.`;
			terminateChild(timeoutError);
		}, timeoutMs);
		resetIdleTimeout();

		stopInterval = setInterval(() => {
			const state = readJson(config.statePath);
			if (state?.stopRequested) {
				try {
					child.kill("SIGTERM");
				} catch {}
			}
		}, STOP_POLL_INTERVAL_MS);

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

	if (stopInterval) {
		clearInterval(stopInterval);
	}
	if (promptDir) {
		try {
			fs.rmSync(promptDir.dir, { recursive: true, force: true });
		} catch {}
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
	return {
		exitCode: normalizedExitCode,
		finalText,
		stopReason,
		error:
			normalizedExitCode === 0
				? undefined
				: timeoutError ||
					idleTimeoutError ||
					assistantError ||
					stderr.trim() ||
					"Subagent completed without a final assistant text response.",
		messages,
		usage,
		tracePath,
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
