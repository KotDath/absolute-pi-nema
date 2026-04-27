import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fetchContent } from "../lib/fetch.ts";
import { searchWeb } from "../lib/search.ts";
import type { WebResultStore } from "../lib/store.ts";
import type { FetchedContent, SearchResponse, SearchResult } from "../lib/types.ts";

const MAX_QUERY_COUNT = 5;
const MAX_INCLUDE_CONTENT_URLS = 10;

function normalizeQueries(params: { query?: string; queries?: string[] }) {
	const values = Array.isArray(params.queries) ? params.queries : params.query ? [params.query] : [];
	return values
		.map((query) => query.trim())
		.filter(Boolean)
		.slice(0, MAX_QUERY_COUNT);
}

function uniqueUrls(searches: SearchResponse[]) {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const search of searches) {
		for (const result of search.results) {
			if (seen.has(result.url)) {
				continue;
			}
			seen.add(result.url);
			urls.push(result.url);
		}
	}
	return urls;
}

function formatResult(result: SearchResult, index: number) {
	const snippet = result.snippet ? `\n   ${result.snippet}` : "";
	return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
}

function formatSearches(searches: SearchResponse[]) {
	const sections: string[] = [];
	for (const search of searches) {
		const heading = searches.length > 1 ? `## ${search.query} (${search.provider})` : `## Results (${search.provider})`;
		if (search.error) {
			sections.push(`${heading}\n\nError: ${search.error}`);
			continue;
		}
		if (search.results.length === 0) {
			sections.push(`${heading}\n\nNo results found.`);
			continue;
		}
		sections.push(`${heading}\n\n${search.results.map(formatResult).join("\n\n")}`);
	}
	return sections.join("\n\n");
}

function formatFetchedSummary(contents: FetchedContent[], responseId: string, totalUrlCount: number) {
	const ok = contents.filter((content) => !content.error).length;
	const capped =
		totalUrlCount > contents.length
			? ` Only the first ${contents.length}/${totalUrlCount} unique URLs were fetched.`
			: "";
	return [
		`Fetched content for ${ok}/${contents.length} result URLs.${capped}`,
		`Use get_web_content({ responseId: "${responseId}", urlIndex: 0, chunkIndex: 0 }) to inspect stored content chunks.`,
	].join("\n");
}

export function registerWebSearch(pi: ExtensionAPI, store: WebResultStore) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the public web without API keys. Uses DuckDuckGo HTML first and falls back to Exa MCP if DuckDuckGo fails. Use queries for multiple related searches.",
		promptSnippet:
			"Use for current or external web research. Prefer queries with 2-4 distinct search angles for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple related search queries." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query. Default 5, max 10." })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch and store content for result URLs." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const queries = normalizeQueries(params);
			if (queries.length === 0) {
				return {
					content: [{ type: "text", text: "Error: provide query or queries." }],
					details: { error: "No query provided." },
				};
			}

			const searches: SearchResponse[] = [];
			for (const [index, query] of queries.entries()) {
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${index + 1}/${queries.length}: ${query}` }],
					details: { phase: "searching", query, progress: index / queries.length },
				});
				searches.push(await searchWeb(query, { numResults: params.numResults, signal }));
			}

			const searchEntry = store.storeSearch(searches);
			pi.appendEntry(store.customType, searchEntry);

			let output = formatSearches(searches);
			let fetchId: string | undefined;
			let fetchedCount = 0;

			if (params.includeContent) {
				const allUrls = uniqueUrls(searches);
				const urls = allUrls.slice(0, MAX_INCLUDE_CONTENT_URLS);
				const contents: FetchedContent[] = [];
				for (const [index, url] of urls.entries()) {
					onUpdate?.({
						content: [{ type: "text", text: `Fetching ${index + 1}/${urls.length}: ${url}` }],
						details: { phase: "fetching", url, progress: index / Math.max(1, urls.length) },
					});
					contents.push(await fetchContent(url, { format: "markdown", signal }));
				}
				const fetchEntry = store.storeFetch(contents);
				pi.appendEntry(store.customType, fetchEntry);
				fetchId = fetchEntry.id;
				fetchedCount = contents.length;
				output += `\n\n---\n${formatFetchedSummary(contents, fetchEntry.id, allUrls.length)}`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					searchId: searchEntry.id,
					fetchId,
					queryCount: queries.length,
					totalResults: searches.reduce((sum, search) => sum + search.results.length, 0),
					fetchedCount,
					providers: searches.map((search) => search.provider),
				},
			};
		},
	});
}
