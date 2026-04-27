import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FetchFormat, fetchContent } from "../lib/fetch.ts";
import type { WebResultStore } from "../lib/store.ts";
import type { FetchedContent } from "../lib/types.ts";

const MAX_INLINE_CHARS = 20_000;
const MAX_URL_COUNT = 20;

function normalizeUrls(params: { url?: string; urls?: string[] }) {
	const values = Array.isArray(params.urls) ? params.urls : params.url ? [params.url] : [];
	return values
		.map((url) => url.trim())
		.filter(Boolean)
		.slice(0, MAX_URL_COUNT);
}

function normalizeFormat(format: unknown): FetchFormat {
	return format === "text" || format === "html" || format === "markdown" ? format : "markdown";
}

function formatSingleContent(content: FetchedContent, responseId: string) {
	if (content.error) {
		return `Error: ${content.error}`;
	}
	const truncated = content.content.length > MAX_INLINE_CHARS;
	const body = truncated ? `${content.content.slice(0, MAX_INLINE_CHARS)}\n\n[Content truncated.]` : content.content;
	const lines = ["", "---", `responseId: ${responseId}`];
	if (truncated) {
		lines.push(`Showing ${MAX_INLINE_CHARS} of ${content.content.length} chars.`);
	}
	lines.push(`Use get_web_content({ responseId: "${responseId}", urlIndex: 0, chunkIndex: 0 }) for stored chunks.`);
	return `${body}\n${lines.join("\n")}`;
}

function formatMultiSummary(contents: FetchedContent[], responseId: string) {
	const lines = ["## Fetched URLs", ""];
	for (const [index, content] of contents.entries()) {
		if (content.error) {
			lines.push(`${index}. ${content.url}: Error - ${content.error}`);
		} else {
			lines.push(`${index}. ${content.title || content.url} (${content.content.length} chars, ${content.source})`);
			lines.push(`   ${content.url}`);
		}
	}
	lines.push("");
	lines.push(
		`Use get_web_content({ responseId: "${responseId}", urlIndex: 0, chunkIndex: 0 }) to retrieve stored content chunks.`,
	);
	return lines.join("\n");
}

export function registerFetchContent(pi: ExtensionAPI, store: WebResultStore) {
	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch URL content and extract readable markdown, text, or HTML. Uses direct HTTP first and Jina Reader fallback for weak or JavaScript-heavy pages.",
		promptSnippet: "Use to read specific URLs. Large results are stored and can be retrieved with get_web_content.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch." })),
			format: Type.Optional(
				StringEnum(["markdown", "text", "html"], { description: "Output format. Default markdown." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const urls = normalizeUrls(params);
			if (urls.length === 0) {
				return {
					content: [{ type: "text", text: "Error: provide url or urls." }],
					details: { error: "No URL provided." },
				};
			}

			const format = normalizeFormat(params.format);
			const contents: FetchedContent[] = [];
			for (const [index, url] of urls.entries()) {
				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${index + 1}/${urls.length}: ${url}` }],
					details: { phase: "fetching", url, progress: index / urls.length },
				});
				contents.push(await fetchContent(url, { format, signal }));
			}

			const entry = store.storeFetch(contents);
			pi.appendEntry(store.customType, entry);
			const successful = contents.filter((content) => !content.error).length;

			return {
				content: [
					{
						type: "text",
						text:
							contents.length === 1 && contents[0]
								? formatSingleContent(contents[0], entry.id)
								: formatMultiSummary(contents, entry.id),
					},
				],
				details: {
					responseId: entry.id,
					urlCount: urls.length,
					successful,
					totalChars: contents.reduce((sum, content) => sum + content.content.length, 0),
				},
			};
		},
	});
}
