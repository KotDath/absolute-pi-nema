import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ACTIVE_TOOL_NAMES, registerAllTools } from "./tools/index.ts";

function activateWebTools(pi: ExtensionAPI) {
	pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ACTIVE_TOOL_NAMES])]);
}

export default function (pi: ExtensionAPI) {
	registerAllTools(pi);

	pi.on("session_start", () => {
		activateWebTools(pi);
	});
}
