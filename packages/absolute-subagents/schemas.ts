import { Type } from "@sinclair/typebox";

export const SpawnAgentSchema = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1 })),
	task: Type.String({ minLength: 1 }),
	mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
});

export const SendAgentMessageSchema = Type.Object({
	runId: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
});

export const WaitAgentSchema = Type.Object({
	runId: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
	pollIntervalMs: Type.Optional(Type.Number({ minimum: 1 })),
});

export const StopAgentSchema = Type.Object({
	runId: Type.String({ minLength: 1 }),
});

export const ListAgentsSchema = Type.Object({
	status: Type.Optional(
		Type.Union([
			Type.Literal("queued"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("stopped"),
		]),
	),
	mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
});

