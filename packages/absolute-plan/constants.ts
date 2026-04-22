export const STATE_ENTRY_TYPE = "absolute-plan:state";
export const CONTEXT_ENTRY_TYPE = "absolute-plan:context";
export const STATUS_KEY = "absolute-plan";
export const PLAN_COMMAND_NAME = "plan";
export const PLAN_SHORTCUT = "alt+p";

export const PLAN_TOOL_NAMES = [
	"set_plan",
	"get_plan",
	"request_user_input",
	"compile_plan",
	"plan_exit",
] as const;
export const EXECUTION_TOOL_NAMES = [
	"get_task_graph",
	"task_update",
	"record_task_result",
	"resume_execution",
	"pause_execution",
] as const;

export const READ_ONLY_DISCOVERY_TOOL_NAMES = ["read", "list_directory", "grep_search", "glob"] as const;
export const MUTATING_TOOL_NAMES = ["write", "edit", "bash"] as const;
export const FALLBACK_ACTIVE_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"bash",
	"list_directory",
	"grep_search",
	"glob",
] as const;

export const READY_APPROVAL_OPTION = "Approve and compile";
export const REVISE_APPROVAL_OPTION = "Keep planning";
export const REJECT_APPROVAL_OPTION = "Reject plan";
