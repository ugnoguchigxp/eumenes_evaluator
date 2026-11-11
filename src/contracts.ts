import { z } from "zod";
import type { ReviewDepth, ReviewQuestion, ReviewStage } from "./investigation";
import type { ResolvedScope } from "./scope";

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;

export const id = z.string().min(1).max(256);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const line = z.number().int().min(1).max(10_000_000);
export const side = z.enum(["base", "head"]);
export const path = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!/[\\\u0000-\u001f]/.test(value) &&
			value
				.split("/")
				.every((segment) => segment && segment !== "." && segment !== ".."),
	);
const lines = z.strictObject({
	startLine: line,
	text: z
		.string()
		.max(MAX_INPUT_BYTES)
		.refine((value) => !value.includes("\r")),
});
const targetRef = z.strictObject({ id, version: id, digest });
const change = z
	.strictObject({
		id,
		path,
		previousPath: path.optional(),
		before: lines.nullable(),
		after: lines.nullable(),
	})
	.refine((value) => value.before !== null || value.after !== null);

const codeTarget = targetRef.extend({
	kind: z.literal("code"),
	base: commit,
	head: commit,
	diffDigest: digest,
	changes: z.array(change).max(1024),
});
const workflowTarget = targetRef.extend({
	kind: z.literal("workflow"),
	document: z.record(z.string(), z.json()),
});
export const targetSchema = z.discriminatedUnion("kind", [
	codeTarget,
	workflowTarget,
]);

const documentEvidence = z.strictObject({
	kind: z.literal("json"),
	id,
	version: id,
	document: z.json(),
	clipped: z.boolean(),
});
const codeEvidence = lines.extend({
	kind: z.literal("lines"),
	id,
	version: id,
	path,
	side,
	clipped: z.boolean(),
});
export const evidenceSchema = z.discriminatedUnion("kind", [
	codeEvidence,
	documentEvidence,
]);

const conditionEntry = z.strictObject({
	id,
	text: z.string().min(1).max(12_000),
	status: z.enum(["confirmed", "proposed", "superseded", "withdrawn"]),
	appliesTo: targetRef,
	sources: z
		.array(
			z.strictObject({
				id,
				version: id,
				active: z.boolean(),
			}),
		)
		.min(1)
		.max(64),
});

export const rubricSchema = z.strictObject({
	id: z.enum(["code-general", "code-correctness", "workflow-correctness"]),
	version: z.literal(1),
});

export const requestSchema = z.strictObject({
	contractVersion: z.literal(1),
	evaluationId: id,
	rubric: rubricSchema,
	target: targetSchema,
	scope: z.array(id).min(1).max(1024),
	evidence: z.array(evidenceSchema).max(1024),
	originalRequest: z.string().min(1).max(24_000).optional(),
	conditions: z.discriminatedUnion("state", [
		z.strictObject({ state: z.literal("none") }),
		z.strictObject({
			state: z.literal("unavailable"),
			reason: z.string().min(1).max(2000),
		}),
		z.strictObject({
			state: z.literal("available"),
			revision: id,
			entries: z.array(conditionEntry).max(1000),
		}),
	]),
	limits: z.strictObject({
		timeoutMs: z.number().int().min(1).max(120_000),
		maxInputBytes: z.number().int().min(1).max(MAX_INPUT_BYTES),
		maxOutputTokens: z.number().int().min(1).max(8192),
	}),
});

export const locationSchema = z.strictObject({
	evidenceId: id,
	startLine: line.nullable(),
	endLine: line.nullable(),
	pointer: z.string().max(2048).nullable(),
});
const finding = z.strictObject({
	title: z.string().min(1).max(240),
	problem: z.string().min(1).max(3000),
	trigger: z.string().min(1).max(2000),
	impact: z.string().min(1).max(2000),
	severity: z.enum(["critical", "high", "medium", "low"]),
	primary: locationSchema,
	evidence: z.array(locationSchema).max(12),
	conditionId: id.nullable(),
});
const explanation = z.string().min(1).max(2000);
const scopeCheck = z.strictObject({
	evidenceId: id,
	status: z.enum(["checked", "unverified"]),
	reason: explanation.nullable(),
});
const conditionCheck = z.strictObject({
	conditionId: id,
	status: z.enum(["satisfied", "violated", "unverified"]),
	reason: explanation,
	evidence: z.array(locationSchema).max(12),
});
export const modelOutputSchema = z.strictObject({
	findings: z.array(finding).max(100),
	scopeChecks: z.array(scopeCheck).max(1024),
	conditionChecks: z.array(conditionCheck).max(1000),
});

export type EvaluationRequest = z.infer<typeof requestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type ModelOutput = z.infer<typeof modelOutputSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Target = z.infer<typeof targetSchema>;
export type ReviewEvidence =
	Evidence | (Extract<Evidence, { kind: "json" }> & { pointerRoot: string });

export interface ModelRequest {
	system: string;
	prompt: string;
	outputSchema: z.core.JSONSchema.JSONSchema;
	maxOutputTokens: number;
}
export interface ModelResponse {
	text: string;
	model?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}
export interface EvaluationModel {
	complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
export interface EvaluationResult extends ModelOutput {
	contractVersion: 1;
	evaluationId: string | null;
	rubric: EvaluationRequest["rubric"] | null;
	target: Pick<Target, "kind" | "id" | "version" | "digest"> | null;
	inputDigest: string | null;
	scopeSelection?: ResolvedScope["summary"];
	review?: {
		depth: ReviewDepth;
		stages: ReviewStage[];
		questions: ReviewQuestion[];
	};
	conditions: "none" | "available" | "unavailable" | null;
	conditionRevision: string | null;
	status: "completed" | "incomplete" | "failed" | "cancelled" | "expired";
	issues: Array<{ code: string; detail?: string }>;
	durationMs: number;
	model?: string;
	usage?: ModelResponse["usage"];
}
