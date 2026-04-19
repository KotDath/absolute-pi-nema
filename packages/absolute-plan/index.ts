import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "plan-ping",
		label: "Plan Ping",
		description: "Ping the plan extension (placeholder)",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "Plan extension not yet implemented" }],
				details: {},
			};
		},
	});
}
