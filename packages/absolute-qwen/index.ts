import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "qwen-ping",
		label: "Qwen Ping",
		description: "Ping the Qwen provider (placeholder)",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "Qwen provider not yet implemented" }],
				details: {},
			};
		},
	});
}
