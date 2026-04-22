export type PlanItemStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanDocStatus = "draft" | "ready";
export type ExecutionMode = "single" | "swarm";
export type TaskStatus = "pending" | "claimed" | "in_progress" | "blocked" | "completed" | "failed";
export type PlanRuntimeMode = "planning" | "execution";
export type PlanRuntimeStatus = "draft" | "approved" | "compiled" | "executing" | "blocked" | "completed" | "failed";
export type PlanApprovalDecision = "approve" | "revise" | "reject" | "cancel";
export type VerificationStatus = "pending" | "running" | "passed" | "failed";
export type PlanItemRisk = "low" | "medium" | "high";
export type TaskComplexityLevel = "low" | "medium" | "high";

export interface PlanRisk {
	risk: string;
	mitigation: string;
}

export interface PlanItem {
	id: string;
	title: string;
	status: PlanItemStatus;
	outcome: string;
	validation: string;
	dependsOn: string[];
	files: string[];
	assumptions: string[];
	risk?: PlanItemRisk;
	hydrate: boolean;
	executionMode: ExecutionMode;
}

export interface PlanDoc {
	version: 1;
	goal: string;
	assumptions: string[];
	openQuestions: string[];
	files: string[];
	items: PlanItem[];
	verification: string[];
	risks: PlanRisk[];
	status: PlanDocStatus;
}

export interface TaskComplexity {
	level: TaskComplexityLevel;
	score: number;
	reasoning: string;
}

export interface TaskNode {
	id: string;
	title: string;
	spec: string;
	status: TaskStatus;
	dependsOn: string[];
	writeScope: string[];
	validation: string[];
	executionMode: ExecutionMode;
	owner?: string;
	artifacts: string[];
	changedFiles: string[];
	blockers: string[];
	notes: string[];
	resultSummary?: string;
	risk?: PlanItemRisk;
	hydrate: boolean;
	followUpOf?: string;
	complexity: TaskComplexity;
}

export interface TaskGraph {
	id: string;
	goal: string;
	verification: string[];
	tasks: TaskNode[];
}

export interface TaskResult {
	taskId: string;
	status: "completed" | "blocked" | "failed" | "needs_review";
	summary: string;
	changedFiles: string[];
	validationsRun: string[];
	artifacts: string[];
	blockers?: string[];
	notes?: string[];
}

export interface ExecutionHistoryEntry {
	at: number;
	type:
		| "execution_started"
		| "task_claimed"
		| "task_started"
		| "task_completed"
		| "task_blocked"
		| "task_failed"
		| "task_followup_created"
		| "verification_started"
		| "verification_passed"
		| "verification_failed"
		| "execution_paused"
		| "execution_resumed"
		| "execution_completed";
	message: string;
	taskId?: string;
	runId?: string;
}

export interface ExecutionState {
	paused: boolean;
	runningRunIds: string[];
	currentTaskId?: string;
	currentRunId?: string;
	history: ExecutionHistoryEntry[];
	verificationStatus: VerificationStatus;
	lastError?: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface PlanSummary {
	active: boolean;
	mode: PlanRuntimeMode;
	runtimeStatus: PlanRuntimeStatus;
	planFilePath?: string;
	status: PlanDocStatus | "none";
	itemCount: number;
	compiled: boolean;
	executingTaskCount: number;
	completedTaskCount: number;
}

export interface PlanModeState {
	version: 2;
	active: boolean;
	mode: PlanRuntimeMode;
	status: PlanRuntimeStatus;
	originLeafId?: string;
	planFilePath?: string;
	lastPlanningLeafId?: string;
	planId?: string;
	compiledTaskGraphId?: string;
	previousActiveTools: string[];
	plan?: PlanDoc;
	validation?: ValidationResult;
	compiledTaskGraph?: TaskGraph;
	feedback?: string;
	execution?: ExecutionState;
}

export interface UserInputQuestion {
	id: string;
	label: string;
	question: string;
	kind: "select" | "input";
	options: string[];
	placeholder?: string;
}

export interface UserInputAnswer {
	id: string;
	label: string;
	answer: string;
}
