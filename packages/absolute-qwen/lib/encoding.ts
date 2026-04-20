import fs from "node:fs";

export type SupportedEncoding = "utf-8" | "utf-16le" | "utf-16be";

export function detectBOM(buffer: Buffer): { encoding: SupportedEncoding; bomLength: number } | null {
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

function decodeText(buffer: Buffer, encoding: SupportedEncoding): string {
	if (encoding === "utf-8") {
		return buffer.toString("utf-8");
	}
	if (encoding === "utf-16le") {
		return buffer.toString("utf16le");
	}
	if (buffer.length % 2 !== 0) {
		throw new Error("UTF-16BE file has an odd number of bytes.");
	}
	const swapped = Buffer.from(buffer);
	swapped.swap16();
	return swapped.toString("utf16le");
}

function encodeText(content: string, encoding: SupportedEncoding): Buffer {
	if (encoding === "utf-8") {
		return Buffer.from(content, "utf-8");
	}
	if (encoding === "utf-16le") {
		return Buffer.from(content, "utf16le");
	}
	const encoded = Buffer.from(content, "utf16le");
	encoded.swap16();
	return encoded;
}

function getBomBytes(encoding: SupportedEncoding): Buffer {
	switch (encoding) {
		case "utf-8":
			return Buffer.from([0xef, 0xbb, 0xbf]);
		case "utf-16le":
			return Buffer.from([0xff, 0xfe]);
		case "utf-16be":
			return Buffer.from([0xfe, 0xff]);
	}
}

export function readFileWithEncoding(filePath: string): {
	content: string;
	encoding: SupportedEncoding;
	hasBOM: boolean;
} {
	const buffer = fs.readFileSync(filePath);
	const bom = detectBOM(buffer);
	const encoding = bom?.encoding ?? "utf-8";
	const hasBOM = bom !== null;
	const content = decodeText(buffer.subarray(bom?.bomLength ?? 0), encoding);
	return { content, encoding, hasBOM };
}

export function writeFileWithEncoding(
	filePath: string,
	content: string,
	options: { encoding: SupportedEncoding; hasBOM: boolean },
) {
	const body = encodeText(content, options.encoding);
	const output = options.hasBOM ? Buffer.concat([getBomBytes(options.encoding), body]) : body;
	fs.writeFileSync(filePath, output);
}
