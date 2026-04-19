import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createUnifiedDiff } from "../lib/diff.ts";
import { preserveLineEnding, readFileWithEncoding } from "../lib/encoding.ts";

const Params = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to modify." }),
	old_string: Type.String({
		description:
			"The exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code).",
	}),
	new_string: Type.String({
		description:
			"The exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code).",
	}),
	replace_all: Type.Optional(
		Type.Boolean({ description: "Set to true to replace every occurrence that matches `old_string`." }),
	),
});

type Params = Static<typeof Params>;

function countOccurrences(content: string, search: string): number {
	if (search.length === 0) {
		return 0;
	}
	let count = 0;
	let pos = content.indexOf(search);
	while (pos !== -1) {
		count++;
		pos = content.indexOf(search, pos + search.length);
	}
	return count;
}

export function registerEdit(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Replaces text within a file. By default, replaces a single occurrence. Set `replace_all` to true when you intend to modify every instance of `old_string`. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.\n\n" +
			"Expectation for required parameters:\n" +
			"1. `file_path` MUST be an absolute path; otherwise an error will be thrown.\n" +
			"2. `old_string` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).\n" +
			"3. `new_string` MUST be the exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.\n" +
			"4. NEVER escape `old_string` or `new_string`, that would break the exact literal text requirement.\n" +
			"**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for `old_string`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.\n" +
			"**Multiple replacements:** Set `replace_all` to true when you want to replace every occurrence that matches `old_string`.",
		promptSnippet: "Replace exact text in a file using absolute path and full literal context.",
		parameters: Params,
		async execute(
			_toolCallId: string,
			params: Params,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const filePath = path.resolve(params.file_path);

			if (!path.isAbsolute(params.file_path)) {
				return {
					content: [{ type: "text", text: `Error: File path must be absolute, but was relative: ${params.file_path}` }],
					details: {},
				};
			}

			if (!fs.existsSync(filePath)) {
				return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }], details: {} };
			}

			try {
				const { content: originalContent } = readFileWithEncoding(filePath);
				const occurrences = countOccurrences(originalContent, params.old_string);

				if (occurrences === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Error: old_string not found in ${filePath}. Make sure the string matches exactly, including whitespace and indentation.`,
							},
						],
						details: {},
					};
				}

				if (occurrences > 1 && !params.replace_all) {
					return {
						content: [
							{
								type: "text",
								text: `Error: old_string matches ${occurrences} locations in ${filePath}. Set replace_all to true to replace all occurrences, or provide more context to uniquely identify the single instance.`,
							},
						],
						details: {},
					};
				}

				let newContent: string;
				if (params.replace_all) {
					newContent = originalContent.split(params.old_string).join(params.new_string);
				} else {
					const index = originalContent.indexOf(params.old_string);
					newContent =
						originalContent.slice(0, index) +
						params.new_string +
						originalContent.slice(index + params.old_string.length);
				}

				// Preserve line endings
				newContent = preserveLineEnding(originalContent, newContent);
				fs.writeFileSync(filePath, newContent, "utf-8");

				const diff = createUnifiedDiff(originalContent, newContent, filePath);
				let text = `Successfully edited ${filePath}`;
				if (diff) {
					text += `\n\n${diff}`;
				}

				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error editing file: ${message}` }], details: {} };
			}
		},
	});
}
