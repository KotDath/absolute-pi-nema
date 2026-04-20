import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const benchRoot = path.join(repoRoot, "bench");
const scenariosRoot = path.join(benchRoot, "scenarios");
const fixturesRoot = path.join(benchRoot, "fixtures");
const piCliPath = path.join(
	repoRoot,
	"node_modules",
	"@mariozechner",
	"pi-coding-agent",
	"dist",
	"cli.js",
);
const extensionPaths = [
	path.join(repoRoot, "packages", "absolute-qwen", "index.ts"),
	path.join(repoRoot, "packages", "absolute-plan", "index.ts"),
];

function parseArgs(argv) {
	const parsed = {
		list: false,
		filters: [],
	};

	for (const arg of argv) {
		if (arg === "--list") {
			parsed.list = true;
			continue;
		}
		parsed.filters.push(arg);
	}

	return parsed;
}

async function collectScenarioFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const results = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await collectScenarioFiles(fullPath)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".json")) {
			results.push(fullPath);
		}
	}

	return results.sort();
}

async function loadScenarios() {
	const files = await collectScenarioFiles(scenariosRoot);
	return Promise.all(
		files.map(async (scenarioPath) => {
			const raw = await fs.readFile(scenarioPath, "utf8");
			const scenario = JSON.parse(raw);
			return {
				...scenario,
				id: scenario.id ?? path.basename(scenarioPath, ".json"),
				suite: scenario.suite ?? "default",
				scenarioPath,
			};
		}),
	);
}

function matchesFilter(scenario, filters) {
	if (filters.length === 0) {
		return true;
	}

	return filters.some((filter) => {
		if (scenario.id === filter || scenario.suite === filter) {
			return true;
		}
		const relativePath = path.relative(scenariosRoot, scenario.scenarioPath);
		return relativePath.includes(filter);
	});
}

function applyTemplate(text, values) {
	return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
		if (!(key in values)) {
			throw new Error(`Unknown template variable: ${key}`);
		}
		return values[key];
	});
}

async function createFixtureWorkspace(fixtureName) {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "absolute-pi-bench-"));
	const fixtureTemplateRoot = fixtureName ? path.join(fixturesRoot, fixtureName) : null;

	if (fixtureTemplateRoot) {
		await fs.cp(fixtureTemplateRoot, workspaceRoot, { recursive: true });
	}

	return workspaceRoot;
}

function getTextContent(message) {
	return (message?.content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

function collectToolCalls(messages) {
	const calls = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const item of message.content ?? []) {
			if (item.type === "toolCall") {
				calls.push(item.name);
			}
		}
	}
	return calls;
}

function collectToolResults(messages) {
	return messages.filter((message) => message.role === "toolResult");
}

async function runPiScenario(scenario, fixtureRoot) {
	const prompt = applyTemplate(scenario.prompt, {
		fixtureRoot,
		repoRoot,
	});
	const args = [
		piCliPath,
		"--no-session",
		"--offline",
		"--no-extensions",
		"--mode",
		"json",
		"--print",
	];

	for (const extensionPath of extensionPaths) {
		args.push("--extension", extensionPath);
	}

	if (Array.isArray(scenario.pi_args)) {
		args.push(...scenario.pi_args.map(String));
	}

	if (process.env.PI_BENCH_PROVIDER) {
		args.push("--provider", process.env.PI_BENCH_PROVIDER);
	}
	if (process.env.PI_BENCH_MODEL) {
		args.push("--model", process.env.PI_BENCH_MODEL);
	}

	args.push(prompt);

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: fixtureRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`pi exited with code ${code}\n${stderr || stdout}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function parseJsonLines(stdout) {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function assertScenario(scenario, fixtureRoot, trace) {
	const agentEnd = trace.find((event) => event.type === "agent_end");
	if (!agentEnd) {
		throw new Error("Trace does not contain agent_end.");
	}

	const messages = agentEnd.messages ?? [];
	const assistantMessages = messages.filter((message) => message.role === "assistant");
	const finalAssistant = assistantMessages.at(-1);
	if (!finalAssistant) {
		throw new Error("Trace does not contain a final assistant message.");
	}

	const toolCalls = collectToolCalls(messages);
	const toolResults = collectToolResults(messages);
	const finalText = getTextContent(finalAssistant);
	const checks = scenario.checks ?? {};

	for (const toolName of checks.must_use_tools ?? []) {
		if (!toolCalls.includes(toolName)) {
			throw new Error(`Expected tool ${toolName} to be used, but got [${toolCalls.join(", ")}].`);
		}
	}

	for (const toolName of checks.must_not_use_tools ?? []) {
		if (toolCalls.includes(toolName)) {
			throw new Error(`Tool ${toolName} must not be used, but got [${toolCalls.join(", ")}].`);
		}
	}

	for (const toolName of checks.must_error_tools ?? []) {
		const errored = toolResults.some((result) => result.toolName === toolName && result.isError === true);
		if (!errored) {
			throw new Error(`Expected tool ${toolName} to fail, but no error result was found.`);
		}
	}

	for (const toolName of checks.must_not_error_tools ?? []) {
		const errored = toolResults.some((result) => result.toolName === toolName && result.isError === true);
		if (errored) {
			throw new Error(`Tool ${toolName} must not fail, but an error result was found.`);
		}
	}

	for (const fragment of checks.final_text_includes ?? []) {
		if (!finalText.includes(fragment)) {
			throw new Error(`Final text does not include ${JSON.stringify(fragment)}.\nActual:\n${finalText}`);
		}
	}

	if (checks.final_text_regex) {
		const regex = new RegExp(checks.final_text_regex, "m");
		if (!regex.test(finalText)) {
			throw new Error(`Final text does not match /${checks.final_text_regex}/.\nActual:\n${finalText}`);
		}
	}

	for (const assertion of checks.files_exact ?? []) {
		const filePath = path.join(fixtureRoot, assertion.path);
		const actual = await fs.readFile(filePath, "utf8");
		if (actual !== assertion.content) {
			throw new Error(
				`File ${assertion.path} does not match expected content.\nExpected:\n${assertion.content}\nActual:\n${actual}`,
			);
		}
	}
}

async function runScenario(scenario) {
	const fixtureRoot = await createFixtureWorkspace(scenario.fixture);
	const tracePath = path.join(fixtureRoot, "trace.jsonl");

	try {
		const { stdout } = await runPiScenario(scenario, fixtureRoot);
		await fs.writeFile(tracePath, stdout, "utf8");
		const trace = parseJsonLines(stdout);
		await assertScenario(scenario, fixtureRoot, trace);
		return {
			status: "passed",
			fixtureRoot,
			tracePath,
		};
	} catch (error) {
		return {
			status: "failed",
			fixtureRoot,
			tracePath,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const scenarios = (await loadScenarios()).filter((scenario) => matchesFilter(scenario, args.filters));

	if (args.list) {
		for (const scenario of scenarios) {
			console.log(`${scenario.suite}\t${scenario.id}\t${path.relative(scenariosRoot, scenario.scenarioPath)}`);
		}
		return;
	}

	if (scenarios.length === 0) {
		console.error("No benchmark scenarios matched.");
		process.exitCode = 1;
		return;
	}

	let failures = 0;
	for (const scenario of scenarios) {
		process.stdout.write(`RUN ${scenario.suite}/${scenario.id} ... `);
		const result = await runScenario(scenario);
		if (result.status === "passed") {
			console.log("ok");
			continue;
		}

		failures++;
		console.log("fail");
		console.error(`  fixture: ${result.fixtureRoot}`);
		console.error(`  trace:   ${result.tracePath}`);
		console.error(`  error:   ${result.error.message}`);
	}

	if (failures > 0) {
		console.error(`\n${failures} benchmark scenario(s) failed.`);
		process.exitCode = 1;
		return;
	}

	console.log(`\nAll ${scenarios.length} benchmark scenario(s) passed.`);
}

await main();
