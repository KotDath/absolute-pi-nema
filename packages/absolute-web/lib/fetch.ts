import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchedContent } from "./types.ts";
import { normalizeHttpUrl, UnsafeUrlError, validatePublicHttpUrl } from "./url.ts";

export type FetchFormat = "markdown" | "text" | "html";

export interface FetchContentOptions {
	format?: FetchFormat;
	signal?: AbortSignal;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_USEFUL_MARKDOWN = 300;
const JINA_READER_PREFIX = "https://r.jina.ai/";
const MAX_REDIRECTS = 5;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeFormat(format: FetchFormat | undefined): FetchFormat {
	return format === "text" || format === "html" || format === "markdown" ? format : "markdown";
}

async function readResponseTextWithLimit(response: Response, maxBytes: number) {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		throw new Error(`Response too large (${Math.ceil(Number(contentLength) / 1024 / 1024)}MB).`);
	}

	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`Response too large (>${Math.ceil(maxBytes / 1024 / 1024)}MB).`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8").decode(buffer);
}

async function fetchPublicUrl(
	inputUrl: string,
	init: RequestInit,
	maxRedirects = MAX_REDIRECTS,
): Promise<{ response: Response; url: string }> {
	let url = await validatePublicHttpUrl(inputUrl);
	for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
		const response = await fetch(url, { ...init, redirect: "manual" });
		if (response.status < 300 || response.status >= 400) {
			return { response, url };
		}

		const location = response.headers.get("location");
		if (!location) {
			return { response, url };
		}
		if (redirect === maxRedirects) {
			throw new Error(`Too many redirects (>${maxRedirects}).`);
		}
		url = await validatePublicHttpUrl(new URL(location, url).toString());
	}
	throw new Error(`Too many redirects (>${maxRedirects}).`);
}

function isLikelyHtml(contentType: string, text: string) {
	return contentType.includes("text/html") || /^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text);
}

function isUnsupportedContent(contentType: string) {
	const normalized = contentType.toLowerCase();
	return (
		normalized.startsWith("image/") ||
		normalized.startsWith("audio/") ||
		normalized.startsWith("video/") ||
		normalized.includes("application/zip") ||
		normalized.includes("application/octet-stream")
	);
}

function extractTextFromHtml(html: string) {
	const { document } = parseHTML(html);
	for (const node of Array.from(document.querySelectorAll("script, style, noscript, iframe, object, embed"))) {
		node.remove();
	}
	return (document.body?.textContent ?? document.textContent ?? "").replace(/\s+/g, " ").trim();
}

function htmlTitle(html: string, fallbackUrl: string) {
	const { document } = parseHTML(html);
	const title = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim();
	if (title) {
		return title;
	}
	return new URL(fallbackUrl).hostname;
}

function extractReadableMarkdown(html: string, url: string) {
	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();
	if (!article) {
		throw new Error("Could not extract readable article content.");
	}
	const markdown = turndown.turndown(article.content ?? "").trim();
	return {
		title: article.title || htmlTitle(html, url),
		content: markdown,
	};
}

function parseJinaMarkdown(raw: string, url: string) {
	const marker = "Markdown Content:";
	const markerIndex = raw.indexOf(marker);
	const content = markerIndex >= 0 ? raw.slice(markerIndex + marker.length).trim() : raw.trim();
	const title =
		raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ??
		content.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim() ??
		new URL(url).hostname;
	return { title, content };
}

async function fetchViaJina(
	url: string,
	format: FetchFormat,
	signal: AbortSignal | undefined,
): Promise<FetchedContent> {
	const response = await fetch(`${JINA_READER_PREFIX}${url}`, {
		headers: {
			Accept: "text/markdown",
			"X-No-Cache": "true",
		},
		signal: withTimeout(signal, DEFAULT_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Jina Reader failed: HTTP ${response.status} ${response.statusText}`);
	}

	const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
	const parsed = parseJinaMarkdown(raw, url);
	if (!parsed.content) {
		throw new Error("Jina Reader returned empty content.");
	}

	return {
		url,
		title: parsed.title,
		format,
		content: format === "text" ? parsed.content.replace(/\s+/g, " ").trim() : parsed.content,
		source: "jina",
	};
}

export async function fetchContent(inputUrl: string, options: FetchContentOptions = {}): Promise<FetchedContent> {
	let url: string;
	const format = normalizeFormat(options.format);
	try {
		url = normalizeHttpUrl(inputUrl);
	} catch (error) {
		return {
			url: inputUrl,
			title: "",
			format,
			content: "",
			error: error instanceof Error ? error.message : String(error),
			source: "direct",
		};
	}

	try {
		const direct = await fetchPublicUrl(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
			},
			signal: withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const response = direct.response;
		url = direct.url;

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (isUnsupportedContent(contentType)) {
			throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
		}

		const raw = await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES);
		const html = isLikelyHtml(contentType, raw);

		if (!html) {
			return {
				url,
				title: new URL(url).pathname.split("/").pop() || new URL(url).hostname,
				format,
				content: raw,
				source: "direct",
			};
		}

		if (format === "html") {
			return {
				url,
				title: htmlTitle(raw, url),
				format,
				content: raw,
				source: "direct",
			};
		}

		if (format === "text") {
			const text = extractTextFromHtml(raw);
			if (text.length < MIN_USEFUL_MARKDOWN) {
				return await fetchViaJina(url, format, options.signal);
			}
			return {
				url,
				title: htmlTitle(raw, url),
				format,
				content: text,
				source: "direct",
			};
		}

		const readable = extractReadableMarkdown(raw, url);
		if (readable.content.length < MIN_USEFUL_MARKDOWN) {
			return await fetchViaJina(url, format, options.signal);
		}

		return {
			url,
			title: readable.title,
			format,
			content: readable.content,
			source: "direct",
		};
	} catch (error) {
		if (error instanceof UnsafeUrlError) {
			return {
				url,
				title: "",
				format,
				content: "",
				error: error.message,
				source: "direct",
			};
		}
		if (format !== "html") {
			try {
				return await fetchViaJina(url, format, options.signal);
			} catch (jinaError) {
				const directMessage = error instanceof Error ? error.message : String(error);
				const jinaMessage = jinaError instanceof Error ? jinaError.message : String(jinaError);
				return {
					url,
					title: "",
					format,
					content: "",
					error: `Direct fetch failed: ${directMessage}\nJina fallback failed: ${jinaMessage}`,
					source: "direct",
				};
			}
		}

		return {
			url,
			title: "",
			format,
			content: "",
			error: error instanceof Error ? error.message : String(error),
			source: "direct",
		};
	}
}
