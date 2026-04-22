import type { PlanDoc } from "./types.js";

function renderBulletSection(title: string, items: string[]): string[] {
	if (items.length === 0) {
		return [`## ${title}`, "", "- None", ""];
	}
	return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
}

export function renderPlanDocMarkdown(plan: PlanDoc): string {
	const lines: string[] = [`# Plan`, "", `- Version: ${plan.version}`, "", `## Goal`, "", plan.goal, ""];

	lines.push(...renderBulletSection("Files", plan.files));
	lines.push(...renderBulletSection("Assumptions", plan.assumptions));
	lines.push(...renderBulletSection("Open Questions", plan.openQuestions));

	lines.push("## Tasks", "");
	for (const item of plan.items) {
		lines.push(`### ${item.id}: ${item.title}`);
		lines.push("");
		lines.push(`- Status: ${item.status}`);
		lines.push(`- Outcome: ${item.outcome}`);
		lines.push(`- Validation: ${item.validation}`);
		lines.push(`- Execution Mode: ${item.executionMode}`);
		lines.push(`- Hydrate: ${item.hydrate ? "yes" : "no"}`);
		lines.push(`- Risk: ${item.risk ?? "n/a"}`);
		lines.push(`- Depends On: ${item.dependsOn.length > 0 ? item.dependsOn.join(", ") : "None"}`);
		lines.push(`- Files: ${item.files.length > 0 ? item.files.join(", ") : "None"}`);
		lines.push(`- Assumptions: ${item.assumptions.length > 0 ? item.assumptions.join(", ") : "None"}`);
		lines.push("");
	}

	lines.push(...renderBulletSection("Verification", plan.verification));

	lines.push("## Risks", "");
	if (plan.risks.length === 0) {
		lines.push("- None", "");
	} else {
		for (const risk of plan.risks) {
			lines.push(`- ${risk.risk}`);
			lines.push(`  Mitigation: ${risk.mitigation}`);
		}
		lines.push("");
	}

	lines.push(`## Plan Status`, "", `- ${plan.status}`, "");
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
