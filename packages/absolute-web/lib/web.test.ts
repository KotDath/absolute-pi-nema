import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchContent } from "./fetch.ts";
import { parseDuckDuckGoResults, parseExaTextResults, searchDuckDuckGo, searchWeb } from "./search.ts";
import {
	MAX_STORED_CONTENT_CHARS,
	readStoredContentChunk,
	toStoredFetchedContent,
	WEB_CONTENT_CHUNK_CHARS,
} from "./store.ts";

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

beforeEach(() => {
	vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("absolute-web search", () => {
	it("parses DuckDuckGo HTML results", () => {
		const results = parseDuckDuckGoResults(
			`
			<div class="result">
				<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">
					Example Docs
				</a>
				<a class="result__snippet">Useful documentation snippet.</a>
			</div>
			`,
			5,
		);

		expect(results).toEqual([
			{
				title: "Example Docs",
				url: "https://example.com/docs",
				snippet: "Useful documentation snippet.",
			},
		]);
	});

	it("falls back to Exa MCP when DuckDuckGo has no parseable results", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const target = String(url);
			if (target.includes("duckduckgo.com")) {
				return new Response("<html>No result markup</html>", { status: 200 });
			}
			return new Response(
				`event: message
data: {"result":{"content":[{"type":"text","text":"Title: Fallback Result\\nURL: https://example.com/fallback\\nHighlights:\\nFallback snippet."}]},"jsonrpc":"2.0","id":1}
`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});

		const result = await searchWeb("fallback query");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.provider).toBe("exa");
		expect(result.results[0]).toMatchObject({
			title: "Fallback Result",
			url: "https://example.com/fallback",
			snippet: "Fallback snippet.",
		});
	});

	it("parses Exa text blocks", () => {
		const results = parseExaTextResults(
			`Title: One
URL: https://example.com/one
Highlights:
First result.

---

Title: Two
URL: https://example.com/two
Highlights:
Second result.`,
			10,
		);

		expect(results.map((result) => result.url)).toEqual(["https://example.com/one", "https://example.com/two"]);
	});

	it("rejects oversized DuckDuckGo HTML responses", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));

		await expect(searchDuckDuckGo("large response")).rejects.toThrow("Response too large");
	});
});

describe("absolute-web fetch", () => {
	it("falls back to Jina Reader when direct extraction is too weak", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const target = String(url);
			if (target.startsWith("https://r.jina.ai/")) {
				return new Response(
					`Title: Example Domain

URL Source: https://example.com/

Markdown Content:
# Example Domain

This domain is for use in documentation examples without needing permission.
`,
					{ status: 200, headers: { "content-type": "text/markdown" } },
				);
			}
			return new Response("<html><head><title>Loading</title></head><body>Loading...</body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});

		const result = await fetchContent("https://example.com", { format: "markdown" });

		expect(result.source).toBe("jina");
		expect(result.title).toBe("Example Domain");
		expect(result.content).toContain("# Example Domain");
	});

	it("returns structured invalid URL errors", async () => {
		const result = await fetchContent("file:///etc/passwd");

		expect(result.error).toContain("Unsupported URL protocol");
		expect(result.content).toBe("");
	});

	it("rejects private and local hosts before fetching", async () => {
		const result = await fetchContent("http://127.0.0.1/admin");

		expect(result.error).toContain("not public");
		expect(result.content).toBe("");
	});

	it("blocks redirects to private addresses", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data" },
			}),
		);

		const result = await fetchContent("https://example.com/redirect", { format: "html" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.error).toContain("not public");
		expect(result.content).toBe("");
	});
});

describe("absolute-web stored content", () => {
	it("caps stored content and splits it into chunks", () => {
		const stored = toStoredFetchedContent({
			url: "https://example.com/large",
			title: "Large",
			format: "markdown",
			content: "x".repeat(MAX_STORED_CONTENT_CHARS + 10),
			source: "direct",
		});

		expect(stored.storedChars).toBe(MAX_STORED_CONTENT_CHARS);
		expect(stored.originalChars).toBe(MAX_STORED_CONTENT_CHARS + 10);
		expect(stored.truncated).toBe(true);
		expect(stored.chunks).toHaveLength(MAX_STORED_CONTENT_CHARS / WEB_CONTENT_CHUNK_CHARS);

		const chunk = readStoredContentChunk(stored, 1);
		expect(chunk.text).toHaveLength(WEB_CONTENT_CHUNK_CHARS);
		expect(chunk.chunkIndex).toBe(1);
		expect(chunk.hasMore).toBe(true);
	});

	it("reads legacy full-content session entries as chunks", () => {
		const chunk = readStoredContentChunk(
			{
				url: "https://example.com/legacy",
				title: "Legacy",
				format: "text",
				content: "a".repeat(WEB_CONTENT_CHUNK_CHARS + 5),
				source: "direct",
			},
			1,
		);

		expect(chunk.text).toBe("a".repeat(5));
		expect(chunk.totalChunks).toBe(2);
		expect(chunk.hasMore).toBe(false);
	});
});
