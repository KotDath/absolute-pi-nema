import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { WebResultStore } from "../lib/store.ts";
import { readStoredContentChunk } from "../lib/store.ts";
import type { StoredFetchedContent } from "../lib/types.ts";

function findContent(contents: StoredFetchedContent[], params: { url?: string; urlIndex?: number }) {
	if (params.url) {
		return contents.find((content) => content.url === params.url);
	}
	if (typeof params.urlIndex === "number") {
		return contents[Math.floor(params.urlIndex)];
	}
	return undefined;
}

export function registerGetWebContent(pi: ExtensionAPI, store: WebResultStore) {
	pi.registerTool({
		name: "get_web_content",
		label: "Get Web Content",
		description: "Retrieve stored content chunks from web_search(includeContent) or fetch_content.",
		promptSnippet:
			"Use after web_search(includeContent) or fetch_content when a responseId points to stored page content. Fetch one chunk at a time.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId returned by web_search or fetch_content." }),
			urlIndex: Type.Optional(Type.Number({ description: "Index of the URL content to retrieve." })),
			url: Type.Optional(Type.String({ description: "Exact URL to retrieve." })),
			chunkIndex: Type.Optional(Type.Number({ description: "Content chunk index. Default 0." })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
			const data = store.get(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: no stored web result for ${params.responseId}.` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}
			if (data.type !== "fetch" || !data.contents) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${params.responseId} is a search result. Use the fetchId from web_search(includeContent) or call fetch_content on a result URL.`,
						},
					],
					details: { error: "Not fetch content", responseId: params.responseId },
				};
			}

			const content = findContent(data.contents, params);
			if (!content) {
				const available = data.contents.map((item, index) => `${index}: ${item.url}`).join("\n");
				return {
					content: [{ type: "text", text: `Error: specify urlIndex or url.\nAvailable:\n${available}` }],
					details: { error: "Content not selected", responseId: params.responseId },
				};
			}
			if (content.error) {
				return {
					content: [{ type: "text", text: `Error for ${content.url}: ${content.error}` }],
					details: { error: content.error, responseId: params.responseId, url: content.url },
				};
			}

			const chunk = readStoredContentChunk(content, params.chunkIndex ?? 0);
			const suffix = [
				"",
				"---",
				`Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}. Stored ${chunk.storedChars}/${chunk.originalChars} chars.`,
				chunk.hasMore
					? `Use get_web_content({ responseId: "${params.responseId}", urlIndex: ${data.contents.indexOf(content)}, chunkIndex: ${chunk.nextChunkIndex} }) for the next chunk.`
					: "No more chunks.",
				chunk.truncated ? "Original content was truncated before storage." : "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: `${chunk.text}\n\n${suffix}` }],
				details: {
					responseId: params.responseId,
					url: content.url,
					title: content.title,
					format: content.format,
					chunkIndex: chunk.chunkIndex,
					totalChunks: chunk.totalChunks,
					hasMore: chunk.hasMore,
					nextChunkIndex: chunk.nextChunkIndex,
					storedChars: chunk.storedChars,
					originalChars: chunk.originalChars,
					truncated: chunk.truncated,
					source: content.source,
				},
			};
		},
	});
}
