import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PlanDoc } from "./types.js";
import { renderPlanDocMarkdown } from "./markdown.js";

function sanitizeSlug(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "plan";
}

function getDefaultPlanFilename(ctx: ExtensionContext): string {
	const datePart = new Date().toISOString().slice(0, 10);
	const sessionName =
		typeof ctx.sessionManager.getSessionFile === "function"
			? path.parse(ctx.sessionManager.getSessionFile?.() ?? "").name
			: "";
	const baseName = sessionName || path.basename(ctx.cwd) || "workspace";
	return `${datePart}-${sanitizeSlug(baseName)}-v1.md`;
}

export async function resolvePlanFilePath(ctx: ExtensionContext, rawLocation: string): Promise<string> {
	const trimmed = rawLocation.trim();
	const defaultPath = path.join(ctx.cwd, "plans", getDefaultPlanFilename(ctx));
	if (!trimmed) {
		return defaultPath;
	}

	const resolvedPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(ctx.cwd, trimmed);
	let treatAsDirectory = /[\\/]$/.test(trimmed);
	try {
		const stats = await stat(resolvedPath);
		if (stats.isDirectory()) {
			treatAsDirectory = true;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			throw error;
		}
	}

	if (treatAsDirectory) {
		return path.join(resolvedPath, getDefaultPlanFilename(ctx));
	}

	return resolvedPath;
}

export async function initializePlanFile(planFilePath: string): Promise<void> {
	await mkdir(path.dirname(planFilePath), { recursive: true });
	await writeFile(planFilePath, "# Planning Draft\n\nPlan has not been written yet.\n", "utf8");
}

export async function writePlanFile(planFilePath: string, plan: PlanDoc): Promise<void> {
	await mkdir(path.dirname(planFilePath), { recursive: true });
	await writeFile(planFilePath, renderPlanDocMarkdown(plan), "utf8");
}
