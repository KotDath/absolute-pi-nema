import { spawn } from "node:child_process";

function buildBackgroundRunnerEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ABSOLUTE_PLAN_AUTOENTER;
	delete env.ABSOLUTE_PLAN_AUTOENTER_PATH;
	return env;
}

export function spawnBackgroundRunner(configPath: string, cwd: string): number | undefined {
	const detached = process.env.ABSOLUTE_SUBAGENTS_RUNNER_DETACHED !== "0";
	const child = spawn(process.execPath, [new URL("./runner.mjs", import.meta.url).pathname, configPath], {
		cwd,
		detached,
		env: buildBackgroundRunnerEnv(),
		stdio: "ignore",
		shell: false,
	});
	if (detached) {
		child.unref();
	}
	return child.pid;
}
