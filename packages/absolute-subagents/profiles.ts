import { DEFAULT_AGENT_NAME } from "./constants.js";
import type { AgentProfile } from "./types.js";

const PROFILES: Record<string, AgentProfile> = {
	worker: {
		name: "worker",
		systemPrompt:
			"You are a focused implementation worker. Execute the assigned task directly, stay within scope, and return a concise machine-readable final result. When the task prompt asks for a JSON object, the final assistant message must be only that JSON object with no extra prose.",
	},
	researcher: {
		name: "researcher",
		systemPrompt:
			"You are a focused researcher. Gather facts, inspect relevant files, and report concrete findings with references.",
	},
	planner: {
		name: "planner",
		systemPrompt:
			"You are a planning specialist. Synthesize a concrete implementation approach and highlight risks and validation.",
	},
	verifier: {
		name: "verifier",
		systemPrompt:
			"You are an adversarial verifier. Validate claims, run checks when allowed, and return failures precisely. When the task prompt asks for a JSON object, the final assistant message must be only that JSON object with no extra prose.",
	},
};

export function resolveAgentProfile(agentName: string | undefined, systemPrompt?: string): AgentProfile {
	const normalizedName = (agentName ?? DEFAULT_AGENT_NAME).trim().toLowerCase();
	const baseProfile = PROFILES[normalizedName] ?? {
		name: normalizedName,
		systemPrompt: `You are the ${normalizedName} subagent. Complete the delegated task directly and return a concise result.`,
	};
	if (!systemPrompt?.trim()) {
		return baseProfile;
	}
	return {
		name: baseProfile.name,
		systemPrompt: `${baseProfile.systemPrompt}\n\n${systemPrompt.trim()}`,
	};
}
