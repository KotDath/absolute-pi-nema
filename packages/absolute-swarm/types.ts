export type CellStatus = "active" | "blocked" | "completed" | "failed";
export type CellAgentRole = "implementer" | "critic" | "verifier";
export type CellMemberStatus = "idle" | "running" | "done" | "failed";
export type BlackboardEntryType = "finding" | "proposal" | "decision" | "question" | "evidence" | "blocker";
export type MailKind = "request" | "reply" | "escalation";
export type ComplexityLevel = "low" | "medium" | "high";

export interface TaskComplexity {
	level: ComplexityLevel;
	score: number;
	reasoning: string;
}

export interface SwarmTaskInput {
	id: string;
	title: string;
	spec: string;
	writeScope: string[];
	validation: string[];
	risk?: "low" | "medium" | "high";
	hydrate: boolean;
	complexity: TaskComplexity;
	notes?: string[];
}

export interface BlackboardEntry {
	id: string;
	type: BlackboardEntryType;
	author: CellAgentRole | "coordinator";
	content: string;
	refs?: string[];
	createdAt: number;
}

export interface MailMessage {
	id: string;
	from: CellAgentRole | "coordinator";
	to: CellAgentRole;
	kind: MailKind;
	content: string;
	createdAt: number;
}

export interface CellMember {
	id: string;
	role: CellAgentRole;
	status: CellMemberStatus;
	runId?: string;
}

export interface CellTaskResult {
	taskId: string;
	status: "completed" | "blocked" | "failed" | "needs_review";
	summary: string;
	changedFiles: string[];
	validationsRun: string[];
	artifacts: string[];
	blockers?: string[];
	notes?: string[];
}

export interface RoleReport {
	summary: string;
	verdict: "continue" | "completed" | "blocked" | "needs_review" | "failed";
	entries: Array<{
		type: BlackboardEntryType;
		content: string;
		refs?: string[];
	}>;
	messages: Array<{
		to: CellAgentRole;
		kind: MailKind;
		content: string;
	}>;
	taskResult?: CellTaskResult;
	validationsRun?: string[];
	notes?: string[];
}

export interface TaskCell {
	id: string;
	task: SwarmTaskInput;
	status: CellStatus;
	currentPhase?: "implementer_plan" | "critic_review" | "implementer_execute" | "verifier_review";
	members: CellMember[];
	blackboard: BlackboardEntry[];
	mailbox: MailMessage[];
	result?: CellTaskResult;
	createdAt: number;
	updatedAt: number;
}

export interface RoleRunResult {
	status: "completed" | "failed" | "stopped";
	finalText: string;
	error?: string;
}

export interface RoleRunner {
	startRole(
		role: CellAgentRole,
		prompt: string,
		context: { cellId: string; taskId: string; phase: TaskCell["currentPhase"] },
	): Promise<{ runId: string }>;
	waitForRun(runId: string): Promise<RoleRunResult>;
	stopRun(runId: string): Promise<void>;
}
