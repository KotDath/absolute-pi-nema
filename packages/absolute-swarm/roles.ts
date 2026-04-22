import { formatBlackboard } from "./blackboard.js";
import { formatMailbox } from "./mailbox.js";
import type { CellTaskResult, RoleReport, TaskCell } from "./types.js";

const REPORT_SHAPE = `{
  "summary": "short factual summary",
  "verdict": "continue|completed|blocked|needs_review|failed",
  "entries": [{"type":"proposal|decision|evidence|blocker|finding|question","content":"...","refs":["..."]}],
  "messages": [{"to":"implementer|critic|verifier","kind":"request|reply|escalation","content":"..."}],
  "taskResult": {"taskId":"...","status":"completed|blocked|failed|needs_review","summary":"...","changedFiles":["..."],"validationsRun":["..."],"artifacts":["..."],"blockers":["..."],"notes":["..."]},
  "validationsRun": ["..."],
  "notes": ["..."]
}`;

function taskHeader(cell: TaskCell): string {
	return [
		`Cell ID: ${cell.id}`,
		`Task ID: ${cell.task.id}`,
		`Task title: ${cell.task.title}`,
		`Task spec: ${cell.task.spec}`,
		`Write scope: ${cell.task.writeScope.join(", ") || "n/a"}`,
		`Validation: ${cell.task.validation.join(" | ")}`,
		`Complexity: ${cell.task.complexity.level} (${cell.task.complexity.score}) - ${cell.task.complexity.reasoning}`,
		`Hydrate: ${cell.task.hydrate ? "yes" : "no"}`,
	].join("\n");
}

export function buildImplementerPlanPrompt(cell: TaskCell): string {
	return [
		taskHeader(cell),
		"",
		"You are the implementer in a bounded task cell.",
		"Produce the initial approach, key risks, and what the critic should challenge.",
		"Write important facts into entries and direct questions into messages.",
		`Return exactly one JSON object shaped like:\n${REPORT_SHAPE}`,
	].join("\n");
}

export function buildCriticPrompt(cell: TaskCell): string {
	return [
		taskHeader(cell),
		"",
		"You are the critic in a bounded task cell.",
		"Challenge the implementer plan, surface blockers and missing evidence, and route the most important feedback back to the implementer.",
		"Only use blocked or failed if the task clearly cannot proceed safely.",
		`Blackboard so far:\n${formatBlackboard(cell)}`,
		`Mailbox so far:\n${formatMailbox(cell, "critic")}`,
		"",
		`Return exactly one JSON object shaped like:\n${REPORT_SHAPE}`,
	].join("\n");
}

export function buildImplementerExecutionPrompt(cell: TaskCell): string {
	return [
		taskHeader(cell),
		"",
		"You are the implementer in the execution phase.",
		"Read the blackboard and critic feedback, then execute the task and return a concrete taskResult.",
		"If you cannot complete safely, return blocked or needs_review in taskResult.",
		`Blackboard so far:\n${formatBlackboard(cell)}`,
		`Mailbox for implementer:\n${formatMailbox(cell, "implementer")}`,
		"",
		`Return exactly one JSON object shaped like:\n${REPORT_SHAPE}`,
	].join("\n");
}

export function buildVerifierPrompt(cell: TaskCell, implementerResult: CellTaskResult): string {
	return [
		taskHeader(cell),
		"",
		"You are the verifier in a bounded task cell.",
		"Check the implementer result against validation criteria and the blackboard evidence.",
		"If validation is insufficient, return blocked or needs_review.",
		`Implementer task result:\n${JSON.stringify(implementerResult, null, 2)}`,
		`Blackboard so far:\n${formatBlackboard(cell)}`,
		`Mailbox for verifier:\n${formatMailbox(cell, "verifier")}`,
		"",
		`Return exactly one JSON object shaped like:\n${REPORT_SHAPE}`,
	].join("\n");
}

function extractJsonCandidate(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		// Continue.
	}
	const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		const candidate = fenced[1].trim();
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			// Continue.
		}
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const candidate = trimmed.slice(start, end + 1);
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			return null;
		}
	}
	return null;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function parseRoleReport(text: string): RoleReport {
	const candidate = extractJsonCandidate(text);
	if (!candidate) {
		return {
			summary: text.trim() || "Role returned no structured output.",
			verdict: "failed",
			entries: [],
			messages: [],
			notes: [],
		};
	}
	const parsed = JSON.parse(candidate) as Record<string, unknown>;
	const verdictValue = typeof parsed.verdict === "string" ? parsed.verdict : "failed";
	return {
		summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "Role returned no summary.",
		verdict:
			verdictValue === "continue" ||
			verdictValue === "completed" ||
			verdictValue === "blocked" ||
			verdictValue === "needs_review" ||
			verdictValue === "failed"
				? verdictValue
				: "failed",
		entries: Array.isArray(parsed.entries)
			? parsed.entries
					.map((entry) => {
						const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
						return {
							type: typeof record.type === "string" ? record.type : "finding",
							content: typeof record.content === "string" ? record.content.trim() : "",
							refs: normalizeStringArray(record.refs),
						};
					})
					.filter((entry) => entry.content.length > 0) as RoleReport["entries"]
			: [],
		messages: Array.isArray(parsed.messages)
			? parsed.messages
					.map((message) => {
						const record = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
						return {
							to: typeof record.to === "string" ? record.to : "implementer",
							kind: typeof record.kind === "string" ? record.kind : "request",
							content: typeof record.content === "string" ? record.content.trim() : "",
						};
					})
					.filter((message) => message.content.length > 0) as RoleReport["messages"]
			: [],
		taskResult:
			typeof parsed.taskResult === "object" && parsed.taskResult !== null
				? {
						taskId:
							typeof (parsed.taskResult as Record<string, unknown>).taskId === "string"
								? ((parsed.taskResult as Record<string, unknown>).taskId as string)
								: "",
						status:
							typeof (parsed.taskResult as Record<string, unknown>).status === "string"
								? (((parsed.taskResult as Record<string, unknown>).status as string) as CellTaskResult["status"])
								: "failed",
						summary:
							typeof (parsed.taskResult as Record<string, unknown>).summary === "string"
								? ((parsed.taskResult as Record<string, unknown>).summary as string)
								: "",
						changedFiles: normalizeStringArray((parsed.taskResult as Record<string, unknown>).changedFiles),
						validationsRun: normalizeStringArray((parsed.taskResult as Record<string, unknown>).validationsRun),
						artifacts: normalizeStringArray((parsed.taskResult as Record<string, unknown>).artifacts),
						blockers: normalizeStringArray((parsed.taskResult as Record<string, unknown>).blockers),
						notes: normalizeStringArray((parsed.taskResult as Record<string, unknown>).notes),
				  }
				: undefined,
		validationsRun: normalizeStringArray(parsed.validationsRun),
		notes: normalizeStringArray(parsed.notes),
	};
}
