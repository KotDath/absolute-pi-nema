import type { CellAgentRole, MailKind, MailMessage, TaskCell } from "./types.js";

let nextMailId = 1;

export function appendMailMessage(
	cell: TaskCell,
	message: { from: CellAgentRole | "coordinator"; to: CellAgentRole; kind: MailKind; content: string },
): MailMessage {
	const created: MailMessage = {
		id: `mail-${nextMailId++}`,
		from: message.from,
		to: message.to,
		kind: message.kind,
		content: message.content.trim(),
		createdAt: Date.now(),
	};
	cell.mailbox.push(created);
	cell.updatedAt = created.createdAt;
	return created;
}

export function formatMailbox(cell: TaskCell, role?: CellAgentRole): string {
	const messages = role ? cell.mailbox.filter((message) => message.to === role || message.from === role) : cell.mailbox;
	if (messages.length === 0) {
		return "No mailbox messages.";
	}
	return messages.map((message) => `- ${message.from} -> ${message.to} [${message.kind}]: ${message.content}`).join("\n");
}
