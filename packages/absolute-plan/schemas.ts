import { Type } from "@sinclair/typebox";

const PlanItemSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	title: Type.String({ minLength: 1 }),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
			Type.Literal("blocked"),
		]),
	),
	outcome: Type.String({ minLength: 1 }),
	validation: Type.String({ minLength: 1 }),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	files: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	hydrate: Type.Optional(Type.Boolean()),
	executionMode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("swarm")])),
});

const PlanRiskSchema = Type.Object({
	risk: Type.String({ minLength: 1 }),
	mitigation: Type.String({ minLength: 1 }),
});

export const PlanDocSchema = Type.Object({
	version: Type.Optional(Type.Literal(1)),
	goal: Type.String({ minLength: 1 }),
	assumptions: Type.Array(Type.String({ minLength: 1 })),
	openQuestions: Type.Array(Type.String({ minLength: 1 })),
	files: Type.Array(Type.String({ minLength: 1 })),
	items: Type.Array(PlanItemSchema, { minItems: 1 }),
	verification: Type.Array(Type.String({ minLength: 1 })),
	risks: Type.Array(PlanRiskSchema),
	status: Type.Union([Type.Literal("draft"), Type.Literal("ready")]),
});

export const SetPlanSchema = Type.Object({
	plan: PlanDocSchema,
});

export const RequestUserInputSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			label: Type.String({ minLength: 1 }),
			question: Type.String({ minLength: 1 }),
			kind: Type.Optional(Type.Union([Type.Literal("select"), Type.Literal("input")])),
			options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			placeholder: Type.Optional(Type.String()),
		}),
		{ minItems: 1, maxItems: 3 },
	),
});

export const PlanExitSchema = Type.Object({
	decision: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("revise"), Type.Literal("reject")])),
});

export const TaskUpdateSchema = Type.Object({
	taskId: Type.String({ minLength: 1 }),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("claimed"),
			Type.Literal("in_progress"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("failed"),
		]),
	),
	owner: Type.Optional(Type.String({ minLength: 1 })),
	notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const TaskResultSchema = Type.Object({
	taskId: Type.String({ minLength: 1 }),
	status: Type.Union([
		Type.Literal("completed"),
		Type.Literal("blocked"),
		Type.Literal("failed"),
		Type.Literal("needs_review"),
	]),
	summary: Type.String({ minLength: 1 }),
	changedFiles: Type.Array(Type.String({ minLength: 1 })),
	validationsRun: Type.Array(Type.String({ minLength: 1 })),
	artifacts: Type.Array(Type.String({ minLength: 1 })),
	blockers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
