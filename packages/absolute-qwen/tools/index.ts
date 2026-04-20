import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { FileAccessState } from "../lib/file-access-state.ts";
import { registerEdit } from "./edit.ts";
import { registerGlob } from "./glob.ts";
import { registerGrepSearch } from "./grep-search.ts";
import { registerListDirectory } from "./list-directory.ts";
import { registerReadFile } from "./read-file.ts";
import { registerRunShell } from "./run-shell.ts";
import { registerWriteFile } from "./write-file.ts";

export const ACTIVE_TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit",
	"run_shell_command",
	"list_directory",
	"grep_search",
	"glob",
] as const;

export function registerAllTools(pi: ExtensionAPI) {
	const fileAccessState = new FileAccessState();

	pi.on("session_start", (_event, ctx) => {
		fileAccessState.rebuild(ctx.sessionManager.getBranch());
	});

	registerReadFile(pi, fileAccessState);
	registerWriteFile(pi, fileAccessState);
	registerEdit(pi, fileAccessState);
	registerRunShell(pi);
	registerListDirectory(pi);
	registerGrepSearch(pi);
	registerGlob(pi);
}
