import { createTaskCell } from "./cell.js";
import { runCellLifecycle } from "./coordinator.js";
import type { RoleRunner, SwarmTaskInput, TaskCell } from "./types.js";

export * from "./types.js";

export interface SwarmRuntime {
	createCell(task: SwarmTaskInput): TaskCell;
	hasCell(cellId: string): boolean;
	runCell(cellId: string): Promise<TaskCell>;
	readCellState(cellId: string): TaskCell | undefined;
	stopCell(cellId: string): Promise<void>;
	collectCellResult(cellId: string): TaskCell["result"];
}

export function createSwarmRuntime(options: { roleRunner: RoleRunner }): SwarmRuntime {
	const cells = new Map<string, TaskCell>();
	const inFlight = new Map<string, Promise<TaskCell>>();

	return {
		createCell(task) {
			const cell = createTaskCell(task);
			cells.set(cell.id, cell);
			return cell;
		},
		hasCell(cellId) {
			return cells.has(cellId);
		},
		runCell(cellId) {
			const existing = inFlight.get(cellId);
			if (existing) {
				return existing;
			}
			const cell = cells.get(cellId);
			if (!cell) {
				throw new Error(`Unknown cell: ${cellId}`);
			}
			const promise = runCellLifecycle(cell, options.roleRunner)
				.catch((error) => {
					cell.status = "failed";
					cell.result = {
						taskId: cell.task.id,
						status: "failed",
						summary: error instanceof Error ? error.message : String(error),
						changedFiles: [],
						validationsRun: [],
						artifacts: [],
						blockers: [error instanceof Error ? error.message : String(error)],
						notes: ["absolute-swarm cell lifecycle threw before producing a terminal result."],
					};
					return cell;
				})
				.finally(() => {
					inFlight.delete(cellId);
				});
			inFlight.set(cellId, promise);
			return promise;
		},
		readCellState(cellId) {
			return cells.get(cellId);
		},
		async stopCell(cellId) {
			const cell = cells.get(cellId);
			if (!cell) {
				return;
			}
			for (const member of cell.members) {
				if (member.runId && member.status === "running") {
					await options.roleRunner.stopRun(member.runId);
				}
			}
			cell.status = "blocked";
			cell.result = {
				taskId: cell.task.id,
				status: "blocked",
				summary: "Task cell stopped before completion.",
				changedFiles: [],
				validationsRun: [],
				artifacts: [],
				blockers: ["Task cell stopped."],
				notes: [],
			};
		},
		collectCellResult(cellId) {
			return cells.get(cellId)?.result;
		},
	};
}
