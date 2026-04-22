import fs from "node:fs";
import path from "node:path";
import type { PiInvocation } from "./types.js";

export function getPiInvocation(args: string[]): PiInvocation {
	const overrideScript = process.env.ABSOLUTE_SUBAGENTS_PI_SCRIPT?.trim();
	if (overrideScript) {
		return {
			command: process.execPath,
			args: [overrideScript, ...args],
		};
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return {
			command: process.execPath,
			args: [currentScript, ...args],
		};
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

