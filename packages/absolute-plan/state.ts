import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	EXECUTION_TOOL_NAMES,
	FALLBACK_ACTIVE_TOOL_NAMES,
	PLAN_TOOL_NAMES,
	READ_ONLY_DISCOVERY_TOOL_NAMES,
	STATE_ENTRY_TYPE,
	STATUS_KEY,
} from "./constants.js";
import { createInitialExecutionState } from "./executor.js";
import type { PlanDoc, PlanModeState, TaskGraph, ValidationResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}

function createInactiveState(): PlanModeState {
	return {
		version: 2,
		active: false,
		mode: "planning",
		status: "draft",
		previousActiveTools: [],
	};
}

function normalizeState(value: unknown): PlanModeState {
	if (!isRecord(value)) {
		return createInactiveState();
	}

	if (value.version === 1) {
		return {
			version: 2,
			active: Boolean(value.active),
			mode: "planning",
			status: value.compiledTaskGraph ? "compiled" : "draft",
			originLeafId: typeof value.originLeafId === "string" ? value.originLeafId : undefined,
			planFilePath: typeof value.planFilePath === "string" ? value.planFilePath : undefined,
			previousActiveTools: normalizeStringArray(value.previousActiveTools),
			plan: value.plan as PlanDoc | undefined,
			validation: value.validation as ValidationResult | undefined,
			compiledTaskGraph: value.compiledTaskGraph as TaskGraph | undefined,
		};
	}

	if (value.version !== 2) {
		return createInactiveState();
	}

	return {
		version: 2,
		active: Boolean(value.active),
		mode: value.mode === "execution" ? "execution" : "planning",
		status:
			value.status === "approved" ||
			value.status === "compiled" ||
			value.status === "executing" ||
			value.status === "blocked" ||
			value.status === "completed" ||
			value.status === "failed"
				? value.status
				: "draft",
		originLeafId: typeof value.originLeafId === "string" ? value.originLeafId : undefined,
		planFilePath: typeof value.planFilePath === "string" ? value.planFilePath : undefined,
		lastPlanningLeafId: typeof value.lastPlanningLeafId === "string" ? value.lastPlanningLeafId : undefined,
		planId: typeof value.planId === "string" ? value.planId : undefined,
		compiledTaskGraphId: typeof value.compiledTaskGraphId === "string" ? value.compiledTaskGraphId : undefined,
		previousActiveTools: normalizeStringArray(value.previousActiveTools),
		plan: value.plan as PlanDoc | undefined,
		validation: value.validation as ValidationResult | undefined,
		compiledTaskGraph: value.compiledTaskGraph as TaskGraph | undefined,
		feedback: typeof value.feedback === "string" ? value.feedback : undefined,
		execution: isRecord(value.execution)
			? {
					paused: Boolean(value.execution.paused),
					runningRunIds: normalizeStringArray(value.execution.runningRunIds),
					currentTaskId: typeof value.execution.currentTaskId === "string" ? value.execution.currentTaskId : undefined,
					currentRunId: typeof value.execution.currentRunId === "string" ? value.execution.currentRunId : undefined,
					history: Array.isArray(value.execution.history) ? (value.execution.history as any[]) : [],
					verificationStatus:
						value.execution.verificationStatus === "running" ||
						value.execution.verificationStatus === "passed" ||
						value.execution.verificationStatus === "failed"
							? value.execution.verificationStatus
							: "pending",
					lastError: typeof value.execution.lastError === "string" ? value.execution.lastError : undefined,
			  }
			: undefined,
	};
}

function getLatestState(ctx: ExtensionContext): PlanModeState {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
			continue;
		}
		return normalizeState(entry.data);
	}
	return createInactiveState();
}

function uniqueTools(tools: string[]): string[] {
	return Array.from(new Set(tools));
}

function summarizeStatus(state: PlanModeState): string {
	if (!state.active) {
		return "";
	}
	if (state.mode === "planning") {
		const itemCount = state.plan?.items.length ?? 0;
		return `PLAN ${state.status} ${itemCount} items planning`;
	}
	const total = state.compiledTaskGraph?.tasks.length ?? 0;
	const completed = state.compiledTaskGraph?.tasks.filter((task) => task.status === "completed").length ?? 0;
	const blocked = state.compiledTaskGraph?.tasks.filter((task) => task.status === "blocked").length ?? 0;
	const running = state.compiledTaskGraph?.tasks.filter(
		(task) => task.status === "claimed" || task.status === "in_progress",
	).length;
	return `PLAN ${state.status} ${completed}/${total} done ${running} running ${blocked} blocked`;
}

export function createPlanStateManager(pi: ExtensionAPI) {
	let state = createInactiveState();

	const persist = () => {
		pi.appendEntry(STATE_ENTRY_TYPE, state);
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, state.active ? summarizeStatus(state) : undefined);
	};

	const syncTools = () => {
		if (!state.active) {
			return;
		}
		if (state.mode === "planning") {
			pi.setActiveTools([...READ_ONLY_DISCOVERY_TOOL_NAMES, ...PLAN_TOOL_NAMES]);
			return;
		}
		const restoredTools = state.previousActiveTools.length > 0 ? state.previousActiveTools : [...FALLBACK_ACTIVE_TOOL_NAMES];
		pi.setActiveTools(uniqueTools([...restoredTools, ...EXECUTION_TOOL_NAMES]));
	};

	const setState = (ctx: ExtensionContext, nextState: PlanModeState, options?: { syncTools?: boolean }) => {
		state = nextState;
		persist();
		if (options?.syncTools ?? true) {
			syncTools();
		}
		applyUi(ctx);
	};

	const mutate = (
		ctx: ExtensionContext,
		updater: (currentState: PlanModeState) => PlanModeState,
		options?: { syncTools?: boolean },
	) => {
		setState(ctx, updater(state), options);
	};

	const refresh = (ctx: ExtensionContext) => {
		state = getLatestState(ctx);
		syncTools();
		applyUi(ctx);
	};

	const enterPlanning = (ctx: ExtensionContext, planFilePath: string) => {
		const currentTools = pi
			.getActiveTools()
			.filter((toolName) => !PLAN_TOOL_NAMES.includes(toolName as never) && !EXECUTION_TOOL_NAMES.includes(toolName as never));
		setState(ctx, {
			version: 2,
			active: true,
			mode: "planning",
			status: "draft",
			originLeafId: ctx.sessionManager.getLeafId?.() ?? undefined,
			lastPlanningLeafId: ctx.sessionManager.getLeafId?.() ?? undefined,
			planFilePath,
			previousActiveTools: currentTools,
			planId: undefined,
			compiledTaskGraphId: undefined,
			plan: undefined,
			validation: undefined,
			compiledTaskGraph: undefined,
			feedback: undefined,
			execution: undefined,
		});
	};

	return {
		getState: () => state,
		refresh,
		syncTools,
		enterPlanning,
		mutate,
		activateExecution(ctx: ExtensionContext, taskGraph: TaskGraph, validation: ValidationResult) {
			const now = Date.now();
			setState(ctx, {
				...state,
				active: true,
				mode: "execution",
				status: "executing",
				lastPlanningLeafId: ctx.sessionManager.getLeafId?.() ?? state.lastPlanningLeafId,
				validation,
				compiledTaskGraph: taskGraph,
				compiledTaskGraphId: `graph-${now.toString(36)}`,
				execution: {
					...createInitialExecutionState(),
					history: [
						{
							at: now,
							type: "execution_started",
							message: "Execution mode started.",
						},
					],
				},
			});
		},
		deactivate(ctx: ExtensionContext) {
			const restoredTools =
				state.previousActiveTools.length > 0 ? state.previousActiveTools : [...FALLBACK_ACTIVE_TOOL_NAMES];
			state = {
				...state,
				active: false,
			};
			persist();
			pi.setActiveTools(restoredTools);
			applyUi(ctx);
		},
	};
}
