import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ACTIVE_TOOL_NAMES, registerAllTools } from "./tools/index.ts";

function activateQwenTools(pi: ExtensionAPI) {
	pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ACTIVE_TOOL_NAMES])]);
}

export default function (pi: ExtensionAPI) {
	registerAllTools(pi);

	pi.on("session_start", () => {
		activateQwenTools(pi);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`

IMPORTANT:
- Thinking is mandatory. Always think through the request before responding or calling tools.
- Do not skip thinking, even for simple tasks.
- When tools are available, think first, then choose the most appropriate tool call.
- Canonical overlapping tool names are read, write, and bash. Their descriptions include qwen-style semantic aliases such as read_file, write_file, and run_shell_command.
`,
		};
	});
}
