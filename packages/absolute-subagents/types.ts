import type { Message } from "@mariozechner/pi-ai";

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export type AgentRunMode = "foreground" | "background";

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentProfile {
	name: string;
	systemPrompt: string;
}

export interface AgentMessageEnvelope {
	id: string;
	runId: string;
	role: "user";
	content: string;
	createdAt: number;
}

export interface AgentTurnResult {
	messageId: string;
	prompt: string;
	exitCode: number;
	finalText: string;
	startedAt: number;
	endedAt: number;
	stopReason?: string;
	error?: string;
	messages: Message[];
	usage: AgentUsage;
	tracePath?: string;
}

export interface AgentResult {
	id: string;
	agent: string;
	mode: AgentRunMode;
	status: AgentRunStatus;
	sessionDir: string;
	turns: AgentTurnResult[];
	finalText: string;
	usage: AgentUsage;
	error?: string;
}

export interface AgentRunState {
	id: string;
	agent: string;
	mode: AgentRunMode;
	status: AgentRunStatus;
	task: string;
	cwd: string;
	createdAt: number;
	startedAt?: number;
	updatedAt: number;
	endedAt?: number;
	pid?: number;
	stopRequested: boolean;
	nextMessageIndex: number;
	sessionDir: string;
	configPath: string;
	resultPath: string;
	inboxPath: string;
	eventsPath: string;
	tracePath?: string;
	stderrPath?: string;
	lastError?: string;
}

export interface AgentRunSnapshot {
	runId: string;
	status: AgentRunStatus;
	mode: AgentRunMode;
	agent: string;
	updatedAt: number;
	resultPath: string;
}

export interface SpawnAgentInput {
	agent?: string;
	task: string;
	mode?: AgentRunMode;
	cwd?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

export interface AgentRunConfig {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	sessionDir: string;
	runDir: string;
	configPath: string;
	statePath: string;
	resultPath: string;
	inboxPath: string;
	eventsPath: string;
	tracePath?: string;
	stderrPath?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface WaitOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface ExecutionOptions {
	runId: string;
	messageId: string;
	prompt: string;
	cwd: string;
	sessionDir: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

export interface ExecutionOutcome {
	exitCode: number;
	finalText: string;
	stopReason?: string;
	error?: string;
	messages: Message[];
	usage: AgentUsage;
}
