import path from "node:path";

export type TrackedToolAction = "read" | "write" | "edit";

export interface FileTrackingDetails {
	tracking?: {
		action: TrackedToolAction;
		path: string;
		version: number;
	};
}

type ToolResultEntryLike = {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
		isError?: boolean;
	};
};

function normalizeTrackedPath(filePath: string): string {
	return path.resolve(filePath);
}

export class FileAccessState {
	private readonly currentVersions = new Map<string, number>();
	private readonly lastReadVersions = new Map<string, number>();

	reset() {
		this.currentVersions.clear();
		this.lastReadVersions.clear();
	}

	rebuild(branchEntries: ToolResultEntryLike[]) {
		this.reset();
		for (const entry of branchEntries) {
			if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.isError) {
				continue;
			}

			const tracking = (entry.message.details as FileTrackingDetails | undefined)?.tracking;
			if (!tracking?.path) {
				continue;
			}

			const filePath = normalizeTrackedPath(tracking.path);
			if (tracking.action === "read") {
				this.currentVersions.set(filePath, tracking.version);
				this.lastReadVersions.set(filePath, tracking.version);
				continue;
			}

			this.currentVersions.set(filePath, tracking.version);
		}
	}

	markRead(filePath: string): number {
		const normalized = normalizeTrackedPath(filePath);
		const version = this.currentVersions.get(normalized) ?? 0;
		this.lastReadVersions.set(normalized, version);
		return version;
	}

	requireFreshRead(filePath: string, toolName: string) {
		const normalized = normalizeTrackedPath(filePath);
		const currentVersion = this.currentVersions.get(normalized) ?? 0;
		const readVersion = this.lastReadVersions.get(normalized);

		if (readVersion === undefined) {
			throw new Error(`Use read_file on ${normalized} before calling ${toolName}.`);
		}

		if (readVersion !== currentVersion) {
			throw new Error(
				`Use read_file on ${normalized} again before calling ${toolName}; the file changed since it was last read.`,
			);
		}
	}

	markMutation(filePath: string): number {
		const normalized = normalizeTrackedPath(filePath);
		const nextVersion = (this.currentVersions.get(normalized) ?? 0) + 1;
		this.currentVersions.set(normalized, nextVersion);
		return nextVersion;
	}
}
