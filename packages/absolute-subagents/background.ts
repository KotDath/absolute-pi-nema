import { spawn } from "node:child_process";

export function spawnBackgroundRunner(configPath: string, cwd: string): number | undefined {
	const detached = process.env.ABSOLUTE_SUBAGENTS_RUNNER_DETACHED !== "0";
	const child = spawn(process.execPath, [new URL("./runner.mjs", import.meta.url).pathname, configPath], {
		cwd,
		detached,
		stdio: "ignore",
		shell: false,
	});
	if (detached) {
		child.unref();
	}
	return child.pid;
}

