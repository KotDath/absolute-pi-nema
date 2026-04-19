import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_CHARS = 50_000;

export function truncateOutput(output: string, maxChars: number = DEFAULT_MAX_CHARS): string {
	if (output.length <= maxChars) {
		return output;
	}

	const truncated = output.slice(0, maxChars);
	const overflow = output.slice(maxChars);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nema-"));
	const tempFile = path.join(tempDir, "truncated-output.txt");
	fs.writeFileSync(tempFile, overflow, "utf-8");

	return `${truncated}\n\n... [Output truncated. Full output saved to: ${tempFile}]`;
}
