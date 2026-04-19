import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createUnifiedDiff } from "../lib/diff.ts";

const Params = Type.Object({
	file_path: Type.String({
		description:
			"The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
	}),
	content: Type.String({ description: "The content to write to the file." }),
});

type Params = Static<typeof Params>;

export function registerWriteFile(pi: ExtensionAPI) {
	pi.registerTool({
		name: "write_file",
		label: "Write File",
		description:
			"Writes content to a specified file in the local filesystem.\n\nThe user has the ability to modify `content`. If modified, this will be stated in the response.",
		promptSnippet: "Write a file by absolute path, creating parent directories if needed.",
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

			try {
				// Auto-create parent directories
				const dir = path.dirname(filePath);
				fs.mkdirSync(dir, { recursive: true });

				// Read existing content for diff
				let existingContent = "";
				if (fs.existsSync(filePath)) {
					existingContent = fs.readFileSync(filePath, "utf-8");
				}

				fs.writeFileSync(filePath, params.content, "utf-8");

				const diff = createUnifiedDiff(existingContent, params.content, filePath);
				let text = `Successfully wrote to ${filePath}`;
				if (diff) {
					text += `\n\n${diff}`;
				}

				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error writing file: ${message}` }], details: {} };
			}
		},
	});
}
