import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DIFF_PREVIEW_CHARS = 4_000;

export function createUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	const maxLines = Math.max(oldLines.length, newLines.length);
	const _contextLines = 3;
	const changes: string[] = [];

	let i = 0;
	while (i < maxLines) {
		if (i >= oldLines.length) {
			changes.push(`+${newLines[i]}`);
		} else if (i >= newLines.length) {
			changes.push(`-${oldLines[i]}`);
		} else if (oldLines[i] !== newLines[i]) {
			changes.push(`-${oldLines[i]}`);
			changes.push(`+${newLines[i]}`);
		}
		i++;
	}

	const removed = changes.filter((l) => l.startsWith("-")).length;
	const added = changes.filter((l) => l.startsWith("+")).length;

	if (changes.length === 0) {
		return "";
	}

	return `--- ${filePath}\n+++ ${filePath}\n@@ ... @@\n${changes.join("\n")}\n(${removed} removed, ${added} added)`;
}

export function summarizeDiff(diff: string) {
	if (!diff) {
		return {
			preview: "",
			truncated: false,
			fullDiffPath: undefined,
		};
	}

	if (diff.length <= MAX_DIFF_PREVIEW_CHARS) {
		return {
			preview: diff,
			truncated: false,
			fullDiffPath: undefined,
		};
	}

	const dir = mkdtempSync(path.join(os.tmpdir(), "apb-diff-"));
	const fullDiffPath = path.join(dir, "edit.diff");
	writeFileSync(fullDiffPath, diff, "utf8");
	return {
		preview: `${diff.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n[Diff preview truncated. Full diff: ${fullDiffPath}]`,
		truncated: true,
		fullDiffPath,
	};
}
