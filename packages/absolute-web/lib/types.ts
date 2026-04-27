export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	query: string;
	provider: "duckduckgo" | "exa";
	results: SearchResult[];
	error?: string;
}

export interface FetchedContent {
	url: string;
	title: string;
	format: "markdown" | "text" | "html";
	content: string;
	error?: string;
	source: "direct" | "jina";
}

export interface StoredFetchedContent {
	url: string;
	title: string;
	format: "markdown" | "text" | "html";
	error?: string;
	source: "direct" | "jina";
	chunks?: string[];
	content?: string;
	originalChars?: number;
	storedChars?: number;
	truncated?: boolean;
}

export interface StoredWebData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	searches?: SearchResponse[];
	contents?: StoredFetchedContent[];
}
