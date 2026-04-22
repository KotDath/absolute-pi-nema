import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, value: unknown): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson<T>(filePath: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

export function appendJsonl(filePath: string, value: unknown): void {
	ensureDir(path.dirname(filePath));
	fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl<T>(filePath: string): T[] {
	try {
		return fs
			.readFileSync(filePath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

export function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

