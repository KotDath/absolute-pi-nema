import type { CellAgentRole, CellMember, SwarmTaskInput, TaskCell } from "./types.js";

let nextCellId = 1;

function createMembers(): CellMember[] {
	const roles: CellAgentRole[] = ["implementer", "critic", "verifier"];
	return roles.map((role) => ({
		id: `member-${role}`,
		role,
		status: "idle",
	}));
}

export function createTaskCell(task: SwarmTaskInput): TaskCell {
	const now = Date.now();
	return {
		id: `cell-${nextCellId++}`,
		task,
		status: "active",
		members: createMembers(),
		blackboard: [],
		mailbox: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function updateMember(cell: TaskCell, role: CellAgentRole, updates: Partial<CellMember>): void {
	cell.members = cell.members.map((member) => (member.role === role ? { ...member, ...updates } : member));
	cell.updatedAt = Date.now();
}
