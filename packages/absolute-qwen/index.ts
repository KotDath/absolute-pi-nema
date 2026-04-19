import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ACTIVE_TOOL_NAMES, registerAllTools } from "./tools/index.ts";

export default function (pi: ExtensionAPI) {
	registerAllTools(pi);

	pi.on("session_start", () => {
		pi.setActiveTools([...ACTIVE_TOOL_NAMES]);
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
`,
		};
	});
}
