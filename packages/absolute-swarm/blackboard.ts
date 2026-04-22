import type { BlackboardEntry, BlackboardEntryType, CellAgentRole, TaskCell } from "./types.js";

let nextEntryId = 1;

export function appendBlackboardEntry(
	cell: TaskCell,
	entry: { type: BlackboardEntryType; author: CellAgentRole | "coordinator"; content: string; refs?: string[] },
): BlackboardEntry {
	const created: BlackboardEntry = {
		id: `bb-${nextEntryId++}`,
		type: entry.type,
		author: entry.author,
		content: entry.content.trim(),
		refs: entry.refs?.filter((ref) => ref.trim().length > 0),
		createdAt: Date.now(),
	};
	cell.blackboard.push(created);
	cell.updatedAt = created.createdAt;
	return created;
}

export function formatBlackboard(cell: TaskCell): string {
	if (cell.blackboard.length === 0) {
		return "No blackboard entries.";
	}
	return cell.blackboard
		.map((entry) => `- [${entry.type}] ${entry.author}: ${entry.content}${entry.refs?.length ? ` (refs: ${entry.refs.join(", ")})` : ""}`)
		.join("\n");
}
