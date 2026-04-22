import { appendBlackboardEntry } from "./blackboard.js";
import { updateMember } from "./cell.js";
import { appendMailMessage } from "./mailbox.js";
import {
	buildCriticPrompt,
	buildImplementerExecutionPrompt,
	buildImplementerPlanPrompt,
	buildVerifierPrompt,
	parseRoleReport,
} from "./roles.js";
import type { CellAgentRole, CellTaskResult, RoleReport, RoleRunner, TaskCell } from "./types.js";

function mergeStringArrays(...lists: Array<string[] | undefined>): string[] {
	return Array.from(
		new Set(
			lists
				.flatMap((list) => list ?? [])
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		),
	);
}

function applyRoleReport(cell: TaskCell, role: CellAgentRole, report: RoleReport) {
	for (const entry of report.entries) {
		appendBlackboardEntry(cell, {
			type: entry.type,
			author: role,
			content: entry.content,
			refs: entry.refs,
		});
	}
	for (const message of report.messages) {
		appendMailMessage(cell, {
			from: role,
			to: message.to,
			kind: message.kind,
			content: message.content,
		});
	}
	if (report.summary.trim().length > 0) {
		appendBlackboardEntry(cell, {
			type: report.verdict === "blocked" || report.verdict === "failed" ? "blocker" : "decision",
			author: role,
			content: report.summary,
		});
	}
}

function toBlockedResult(taskId: string, summary: string, notes?: string[]): CellTaskResult {
	return {
		taskId,
		status: "blocked",
		summary,
		changedFiles: [],
		validationsRun: [],
		artifacts: [],
		blockers: [summary],
		notes,
	};
}

async function runRolePhase(
	cell: TaskCell,
	role: CellAgentRole,
	phase: TaskCell["currentPhase"],
	prompt: string,
	roleRunner: RoleRunner,
): Promise<RoleReport> {
	cell.currentPhase = phase;
	updateMember(cell, role, { status: "running" });
	const started = await roleRunner.startRole(role, prompt, {
		cellId: cell.id,
		taskId: cell.task.id,
		phase,
	});
	updateMember(cell, role, { runId: started.runId });
	const result = await roleRunner.waitForRun(started.runId);
	if (result.status !== "completed") {
		updateMember(cell, role, { status: "failed" });
		return {
			summary: result.error || `${role} ${phase ?? "phase"} did not complete successfully.`,
			verdict: result.status === "stopped" ? "blocked" : "failed",
			entries: [],
			messages: [],
			notes: result.error ? [result.error] : [],
		};
	}
	const report = parseRoleReport(result.finalText);
	updateMember(cell, role, { status: report.verdict === "failed" ? "failed" : "done" });
	applyRoleReport(cell, role, report);
	return report;
}

function finalizeFromVerifier(taskId: string, implementerResult: CellTaskResult, verifier: RoleReport): CellTaskResult {
	if (verifier.verdict === "completed") {
		return {
			...implementerResult,
			status: "completed",
			summary: verifier.summary || implementerResult.summary,
			validationsRun: mergeStringArrays(implementerResult.validationsRun, verifier.validationsRun),
			notes: mergeStringArrays(implementerResult.notes, verifier.notes),
		};
	}
	return {
		taskId,
		status: verifier.verdict === "failed" ? "failed" : verifier.verdict === "needs_review" ? "needs_review" : "blocked",
		summary: verifier.summary,
		changedFiles: [...implementerResult.changedFiles],
		validationsRun: mergeStringArrays(implementerResult.validationsRun, verifier.validationsRun),
		artifacts: [...implementerResult.artifacts],
		blockers: mergeStringArrays(implementerResult.blockers, verifier.notes, [verifier.summary]),
		notes: mergeStringArrays(implementerResult.notes, verifier.notes),
	};
}

export async function runCellLifecycle(cell: TaskCell, roleRunner: RoleRunner): Promise<TaskCell> {
	const implementerPlan = await runRolePhase(cell, "implementer", "implementer_plan", buildImplementerPlanPrompt(cell), roleRunner);
	if (implementerPlan.verdict === "failed") {
		cell.status = "failed";
		cell.result = {
			taskId: cell.task.id,
			status: "failed",
			summary: implementerPlan.summary,
			changedFiles: [],
			validationsRun: [],
			artifacts: [],
			blockers: [implementerPlan.summary],
			notes: implementerPlan.notes,
		};
		return cell;
	}

	const critic = await runRolePhase(cell, "critic", "critic_review", buildCriticPrompt(cell), roleRunner);
	if (critic.verdict === "failed") {
		cell.status = "failed";
		cell.result = {
			taskId: cell.task.id,
			status: "failed",
			summary: critic.summary,
			changedFiles: [],
			validationsRun: [],
			artifacts: [],
			blockers: [critic.summary],
			notes: critic.notes,
		};
		return cell;
	}

	const implementerExecution = await runRolePhase(
		cell,
		"implementer",
		"implementer_execute",
		buildImplementerExecutionPrompt(cell),
		roleRunner,
	);
	const implementerResult =
		implementerExecution.taskResult && implementerExecution.taskResult.summary.trim().length > 0
			? implementerExecution.taskResult
			: toBlockedResult(cell.task.id, implementerExecution.summary, implementerExecution.notes);

	if (implementerResult.status === "failed") {
		cell.status = "failed";
		cell.result = implementerResult;
		return cell;
	}

	const verifier = await runRolePhase(
		cell,
		"verifier",
		"verifier_review",
		buildVerifierPrompt(cell, implementerResult),
		roleRunner,
	);
	const finalResult = finalizeFromVerifier(cell.task.id, implementerResult, verifier);
	cell.result = finalResult;
	cell.status =
		finalResult.status === "completed" ? "completed" : finalResult.status === "failed" ? "failed" : "blocked";
	return cell;
}
