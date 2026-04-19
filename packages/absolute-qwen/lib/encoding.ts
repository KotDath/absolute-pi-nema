import fs from "node:fs";

const _BOM_MAP: Record<string, { encoding: string; bomLength: number }> = {
	"\u{FEFF}": { encoding: "utf-8", bomLength: 3 },
	"\u{FFFE}": { encoding: "utf-16le", bomLength: 2 },
	"\u{FEFF}\0": { encoding: "utf-16be", bomLength: 2 },
};

export function detectBOM(buffer: Buffer): { encoding: string; bomLength: number } | null {
	if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return { encoding: "utf-8", bomLength: 3 };
	}
	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		return { encoding: "utf-16le", bomLength: 2 };
	}
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		return { encoding: "utf-16be", bomLength: 2 };
	}
	return null;
}

export function detectLineEnding(content: string): "lf" | "crlf" {
	const crlfIndex = content.indexOf("\r\n");
	if (crlfIndex !== -1) {
		return "crlf";
	}
	return "lf";
}

export function preserveLineEnding(original: string, replacement: string): string {
	const ending = detectLineEnding(original);
	if (ending === "crlf") {
		return replacement.replace(/(?<!\r)\n/g, "\r\n");
	}
	return replacement;
}

export function readFileWithEncoding(filePath: string): { content: string; encoding: string; hasBOM: boolean } {
	const buffer = fs.readFileSync(filePath);
	const bom = detectBOM(buffer);
	const encoding = bom?.encoding ?? "utf-8";
	const hasBOM = bom !== null;
	const content = buffer.toString("utf-8", bom?.bomLength ?? 0);
	return { content, encoding, hasBOM };
}
