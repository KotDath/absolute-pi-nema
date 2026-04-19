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
