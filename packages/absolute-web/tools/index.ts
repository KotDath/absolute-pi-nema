import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { WebResultStore } from "../lib/store.ts";
import { registerFetchContent } from "./fetch-content.ts";
import { registerGetWebContent } from "./get-web-content.ts";
import { registerWebSearch } from "./web-search.ts";

export const ACTIVE_TOOL_NAMES = ["web_search", "fetch_content", "get_web_content"] as const;

export function registerAllTools(pi: ExtensionAPI) {
	const store = new WebResultStore();

	pi.on("session_start", (_event, ctx) => {
		store.restore(ctx.sessionManager.getBranch());
	});

	registerWebSearch(pi, store);
	registerFetchContent(pi, store);
	registerGetWebContent(pi, store);
}
