import { parseHTML } from "linkedom";
import type { SearchResponse, SearchResult } from "./types.ts";
import { htmlDecode } from "./url.ts";

const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SEARCH_RESPONSE_BYTES = 1 * 1024 * 1024;

export interface SearchOptions {
	numResults?: number;
	signal?: AbortSignal;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeResultCount(value: number | undefined) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 5;
	}
	return Math.max(1, Math.min(Math.floor(value), 10));
}

async function readResponseTextWithLimit(response: Response, maxBytes: number) {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		throw new Error(`Response too large (${Math.ceil(Number(contentLength) / 1024)}KB).`);
	}
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		throw new Error(`Response too large (>${Math.ceil(maxBytes / 1024)}KB).`);
	}
	return text;
}

function nodeText(node: Element | null | undefined) {
	return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function decodeDuckDuckGoUrl(rawHref: string) {
	const href = htmlDecode(rawHref);
	try {
		const parsed = new URL(href, DUCKDUCKGO_URL);
		const uddg = parsed.searchParams.get("uddg");
		if (uddg) {
			return decodeURIComponent(uddg);
		}
		return parsed.toString();
	} catch {
		return href;
	}
}

function isUsableSearchUrl(rawUrl: string) {
	try {
		const url = new URL(rawUrl);
		if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/y.js") {
			return false;
		}
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];
	const anchors = Array.from(document.querySelectorAll("a.result__a"));

	for (const anchor of anchors) {
		if (results.length >= maxResults) {
			break;
		}

		const href = anchor.getAttribute("href");
		if (!href) {
			continue;
		}

		const resultContainer = anchor.closest(".result");
		const snippet = nodeText(resultContainer?.querySelector(".result__snippet"));
		const title = nodeText(anchor);
		const url = decodeDuckDuckGoUrl(href);

		if (!title || !isUsableSearchUrl(url)) {
			continue;
		}

		results.push({ title, url, snippet });
	}

	return results;
}

export async function searchDuckDuckGo(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const count = normalizeResultCount(options.numResults);
	const params = new URLSearchParams({ q: query });
	const response = await fetch(`${DUCKDUCKGO_URL}?${params.toString()}`, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`);
	}

	const html = await readResponseTextWithLimit(response, MAX_SEARCH_RESPONSE_BYTES);
	const results = parseDuckDuckGoResults(html, count);
	if (results.length === 0) {
		throw new Error("DuckDuckGo returned no parseable results.");
	}

	return { query, provider: "duckduckgo", results };
}

interface ExaMcpResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: {
		code?: number;
		message?: string;
	};
}

function parseExaSse(body: string): ExaMcpResponse | null {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const payload = line.slice(5).trim();
		if (!payload) {
			continue;
		}
		try {
			const parsed = JSON.parse(payload) as ExaMcpResponse;
			if (parsed.result || parsed.error) {
				return parsed;
			}
		} catch {}
	}

	try {
		const parsed = JSON.parse(body) as ExaMcpResponse;
		return parsed.result || parsed.error ? parsed : null;
	} catch {
		return null;
	}
}

export function parseExaTextResults(text: string, maxResults: number): SearchResult[] {
	const blocks = text.split(/(?=^Title: )/m);
	const results: SearchResult[] = [];

	for (const block of blocks) {
		if (results.length >= maxResults) {
			break;
		}
		const title = block.match(/^Title: (.+)$/m)?.[1]?.trim();
		const url = block.match(/^URL: (.+)$/m)?.[1]?.trim();
		if (!title || !url) {
			continue;
		}

		let snippet = "";
		const highlightsIndex = block.indexOf("\nHighlights:");
		if (highlightsIndex >= 0) {
			snippet = block
				.slice(highlightsIndex + "\nHighlights:".length)
				.replace(/\n---\s*$/m, "")
				.replace(/\s+/g, " ")
				.trim();
		}
		if (snippet.length > 500) {
			snippet = `${snippet.slice(0, 497)}...`;
		}

		results.push({ title, url, snippet });
	}

	return results;
}

export async function searchExaMcp(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const count = normalizeResultCount(options.numResults);
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: {
					query,
					numResults: count,
					livecrawl: "fallback",
					type: "auto",
					contextMaxCharacters: 3000,
				},
			},
		}),
		signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Exa MCP search failed: HTTP ${response.status} ${text.slice(0, 200)}`);
	}

	const body = await response.text();
	const parsed = parseExaSse(body);
	if (!parsed) {
		throw new Error("Exa MCP returned an unreadable response.");
	}
	if (parsed.error) {
		throw new Error(`Exa MCP error: ${parsed.error.message ?? parsed.error.code ?? "unknown"}`);
	}
	if (parsed.result?.isError) {
		const message = parsed.result.content?.find((item) => item.type === "text")?.text;
		throw new Error(message ?? "Exa MCP returned an error.");
	}

	const text = parsed.result?.content?.find((item) => item.type === "text")?.text ?? "";
	const results = parseExaTextResults(text, count);
	if (results.length === 0) {
		throw new Error("Exa MCP returned no parseable results.");
	}

	return { query, provider: "exa", results };
}

export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	try {
		return await searchDuckDuckGo(query, options);
	} catch (duckDuckGoError) {
		try {
			return await searchExaMcp(query, options);
		} catch (exaError) {
			const ddgMessage = duckDuckGoError instanceof Error ? duckDuckGoError.message : String(duckDuckGoError);
			const exaMessage = exaError instanceof Error ? exaError.message : String(exaError);
			return {
				query,
				provider: "duckduckgo",
				results: [],
				error: `DuckDuckGo failed: ${ddgMessage}\nExa fallback failed: ${exaMessage}`,
			};
		}
	}
}
