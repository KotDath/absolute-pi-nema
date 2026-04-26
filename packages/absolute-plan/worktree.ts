import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface GitRepoInfo {
	repoRoot: string;
	headRef: string;
}

export interface WorktreeAttempt {
	repoRoot: string;
	baseRef: string;
	worktreePath: string;
}

function runGit(args: string[], cwd: string, options?: { input?: string; allowFailure?: boolean }) {
	const result = spawnSync("git", args, {
		cwd,
		shell: false,
		encoding: "utf8",
		input: options?.input,
	});
	if (result.status !== 0 && !options?.allowFailure) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result;
}

export function resolveGitRepo(cwd: string): GitRepoInfo | null {
	const root = runGit(["rev-parse", "--show-toplevel"], cwd, { allowFailure: true });
	if (root.status !== 0) {
		return null;
	}
	const head = runGit(["rev-parse", "HEAD"], cwd, { allowFailure: true });
	if (head.status !== 0) {
		return null;
	}
	return {
		repoRoot: root.stdout.trim(),
		headRef: head.stdout.trim(),
	};
}

export function createAttemptWorktree(repo: GitRepoInfo, taskId: string, attempt: number): WorktreeAttempt {
	const prefix = path.join(os.tmpdir(), `${path.basename(repo.repoRoot)}-${taskId.replace(/[^a-zA-Z0-9_-]+/g, "-")}-attempt-${attempt}-`);
	const worktreePath = mkdtempSync(prefix);
	runGit(["worktree", "add", "--detach", worktreePath, repo.headRef], repo.repoRoot);
	return {
		repoRoot: repo.repoRoot,
		baseRef: repo.headRef,
		worktreePath,
	};
}

export function buildWorktreePatch(attempt: WorktreeAttempt): { patch: string; changedFiles: string[] } {
	runGit(["add", "-N", "."], attempt.worktreePath);
	const patch = runGit(["diff", "--binary", attempt.baseRef, "--"], attempt.worktreePath).stdout;
	const changedFiles = runGit(["diff", "--name-only", attempt.baseRef, "--"], attempt.worktreePath)
		.stdout.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return { patch, changedFiles };
}

export function applyWorktreePatch(repoRoot: string, patch: string): void {
	runGit(["apply", "--3way", "--whitespace=nowarn", "-"], repoRoot, { input: patch });
}

export function removeAttemptWorktree(attempt: WorktreeAttempt): void {
	runGit(["worktree", "remove", "--force", attempt.worktreePath], attempt.repoRoot, { allowFailure: true });
	rmSync(attempt.worktreePath, { recursive: true, force: true });
}
