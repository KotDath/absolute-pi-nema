import path from "node:path";

export function stripPathSigil(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function ensureAbsolutePath(input: string, label: string = "Path"): string {
	const normalized = stripPathSigil(input).trim();
	if (!path.isAbsolute(normalized)) {
		throw new Error(`${label} must be absolute: ${input}`);
	}
	return path.resolve(normalized);
}

export function resolveWorkingDirectory(input: string | undefined, cwd: string): string {
	if (!input) {
		return cwd;
	}
	const normalized = stripPathSigil(input).trim();
	return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}
