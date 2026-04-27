import type { FetchedContent, SearchResponse, StoredFetchedContent, StoredWebData } from "./types.ts";

const CUSTOM_TYPE = "absolute-web-results";
export const MAX_STORED_CONTENT_CHARS = 200_000;
export const WEB_CONTENT_CHUNK_CHARS = 20_000;

type BranchEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
};

function createId() {
	return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isStoredWebData(value: unknown): value is StoredWebData {
	if (!value || typeof value !== "object") {
		return false;
	}
	const data = value as { id?: unknown; type?: unknown; timestamp?: unknown };
	return (
		typeof data.id === "string" &&
		(data.type === "search" || data.type === "fetch") &&
		typeof data.timestamp === "number"
	);
}

function chunkText(text: string, chunkSize: number) {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += chunkSize) {
		chunks.push(text.slice(index, index + chunkSize));
	}
	return chunks;
}

export function toStoredFetchedContent(content: FetchedContent): StoredFetchedContent {
	const stored = content.content.slice(0, MAX_STORED_CONTENT_CHARS);
	return {
		url: content.url,
		title: content.title,
		format: content.format,
		error: content.error,
		source: content.source,
		chunks: chunkText(stored, WEB_CONTENT_CHUNK_CHARS),
		originalChars: content.content.length,
		storedChars: stored.length,
		truncated: content.content.length > stored.length,
	};
}

export function readStoredContentChunk(content: StoredFetchedContent, chunkIndex: number) {
	const rawChunks = content.chunks ?? chunkText(content.content ?? "", WEB_CONTENT_CHUNK_CHARS);
	const totalChunks = Math.max(1, rawChunks.length);
	const normalizedIndex = Math.max(0, Math.floor(chunkIndex));
	const selectedIndex = Math.min(normalizedIndex, totalChunks - 1);
	const text = rawChunks[selectedIndex] ?? "";
	const storedChars = content.storedChars ?? rawChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const originalChars = content.originalChars ?? content.content?.length ?? storedChars;

	return {
		text,
		chunkIndex: selectedIndex,
		totalChunks,
		hasMore: selectedIndex + 1 < totalChunks,
		nextChunkIndex: selectedIndex + 1 < totalChunks ? selectedIndex + 1 : undefined,
		storedChars,
		originalChars,
		truncated: content.truncated ?? originalChars > storedChars,
	};
}

export class WebResultStore {
	readonly customType = CUSTOM_TYPE;
	private readonly entries = new Map<string, StoredWebData>();

	reset() {
		this.entries.clear();
	}

	restore(branchEntries: BranchEntryLike[]) {
		this.reset();
		for (const entry of branchEntries) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isStoredWebData(entry.data)) {
				continue;
			}
			this.entries.set(entry.data.id, entry.data);
		}
	}

	storeSearch(searches: SearchResponse[]) {
		const data: StoredWebData = {
			id: createId(),
			type: "search",
			timestamp: Date.now(),
			searches,
		};
		this.entries.set(data.id, data);
		return data;
	}

	storeFetch(contents: FetchedContent[]) {
		const data: StoredWebData = {
			id: createId(),
			type: "fetch",
			timestamp: Date.now(),
			contents: contents.map(toStoredFetchedContent),
		};
		this.entries.set(data.id, data);
		return data;
	}

	get(id: string) {
		return this.entries.get(id);
	}
}
