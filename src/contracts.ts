import { z } from "zod";
import type { ReviewDepth, ReviewQuestion, ReviewStage } from "./investigation";
import type { ResolvedScope } from "./scope";

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_SCOPE_CHECKS = 1024;
const MAX_JSON_DEPTH = 128;
export const MAX_ID_LENGTH = 256;
const MAX_LINE_NUMBER = 10_000_000;

export const id = z.string().min(1).max(MAX_ID_LENGTH);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const line = z.number().int().min(1).max(MAX_LINE_NUMBER);
export const side = z.enum(["base", "head"]);
export const path = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			// oxlint-disable-next-line no-control-regex -- Fixed evidence paths exclude control characters.
			!/[\\\u0000-\u001f]/.test(value) &&
			value
				.split("/")
				.every((segment) => segment && segment !== "." && segment !== ".."),
	);
const lines = z
	.strictObject({
		startLine: line,
		text: z
			.string()
			.max(MAX_INPUT_BYTES)
			.refine((value) => !value.includes("\r")),
	})
	.refine(
		({ startLine, text }) =>
			startLine + text.split("\n").length - (text.endsWith("\n") ? 2 : 1) <=
			MAX_LINE_NUMBER,
		{ path: ["text"], message: "Excerpt exceeds the maximum line number" },
	);
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
type JsonValue = z.core.util.JSONType;

function isJsonValue(
	value: unknown,
	budget: { nodes: number },
	depth = 0,
): value is JsonValue {
	// Every JSON value requires at least one byte in the serialized request.
	if (depth > MAX_JSON_DEPTH || --budget.nodes < 0) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (
				!Object.hasOwn(value, index) ||
				!isJsonValue(value[index], budget, depth + 1)
			)
				return false;
		}
		return true;
	}
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.values(value).every((child) => isJsonValue(child, budget, depth + 1))
	);
}

// Preserve JSON keys such as "__proto__" and detach the snapshot from the caller.
const jsonDocument = z
	.unknown()
	.refine(
		(value): value is JsonValue =>
			isJsonValue(value, { nodes: MAX_INPUT_BYTES }),
		{ abort: true },
	)
	.overwrite((value) => structuredClone(value));
const workflowTarget = targetRef.extend({
	kind: z.literal("workflow"),
	document: jsonDocument
		.refine(
			(value): value is Record<string, JsonValue> =>
				value !== null && typeof value === "object" && !Array.isArray(value),
		)
		.meta({ type: "object" }),
});
export const targetSchema = z.discriminatedUnion("kind", [
	codeTarget,
	workflowTarget,
]);

const documentEvidence = z.strictObject({
	kind: z.literal("json"),
	id,
	version: id,
	document: jsonDocument.meta({
		type: ["null", "boolean", "number", "string", "array", "object"],
	}),
	clipped: z.boolean(),
});
const codeEvidence = lines.safeExtend({
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
	scope: z.array(id).min(1).max(MAX_SCOPE_CHECKS),
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
	scopeChecks: z.array(scopeCheck).max(MAX_SCOPE_CHECKS),
	conditionChecks: z.array(conditionCheck).max(1000),
});

export type EvaluationRequest = z.infer<typeof requestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type ModelOutput = z.infer<typeof modelOutputSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Target = z.infer<typeof targetSchema>;
export type ReviewEvidence =
	Evidence | (Extract<Evidence, { kind: "json" }> & { pointerRoot: string });

export type ExcludedCondition = {
	id: string;
	reason: "not_confirmed" | "target_mismatch" | "source_inactive";
};
export type RejectedOutput = {
	kind: keyof ModelOutput | "questionChecks";
	index: number;
	reason: string;
};

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
export const issueCodes = [
	"cancelled",
	"condition_sources_inactive",
	"condition_target_mismatch",
	"conditions_unavailable",
	"conditions_unverified",
	"deadline_exceeded",
	"duplicate_condition",
	"duplicate_evidence_or_scope",
	"empty_diff_excerpt",
	"evidence_version_mismatch",
	"invalid_diff",
	"invalid_investigation_output",
	"invalid_model_output",
	"invalid_request",
	"invalid_review_depth",
	"invalid_scope_selection",
	"investigation_evidence_unavailable",
	"investigation_questions_unverified",
	"model_output_partially_rejected",
	"model_request_failed",
	"prompt_size_limit",
	"request_size_limit",
	"required_conditions_unavailable",
	"rubric_target_mismatch",
	"scope_evidence_id_conflict",
	"scope_evidence_not_allowed",
	"scope_preview_mismatch",
	"scope_required_for_depth",
	"scope_required_for_preview_digest",
	"scope_selector_no_match",
	"scope_selector_target_mismatch",
	"scope_size_limit",
	"scope_target_mismatch",
	"scope_unverified",
	"steering_requires_standard",
	"target_digest_mismatch",
	"target_scope_missing",
] as const;
export type IssueCode = (typeof issueCodes)[number];

export interface EvaluationResult extends ModelOutput {
	contractVersion: 1;
	evaluationId: string | null;
	rubric: EvaluationRequest["rubric"] | null;
	target: Pick<Target, "kind" | "id" | "version" | "digest"> | null;
	inputDigest: string | null;
	scopeSelection?: ResolvedScope["summary"];
	steering?: {
		outcome: "committed" | "released" | "unknown";
		evidenceIds: string[];
		ignored: number;
		reason?: "input_budget";
	};
	review?: {
		depth: ReviewDepth;
		stages: ReviewStage[];
		questions: ReviewQuestion[];
	};
	conditions: "none" | "available" | "unavailable" | null;
	conditionRevision: string | null;
	conditionSelection: { applied: string[]; excluded: ExcludedCondition[] };
	rejected: RejectedOutput[];
	status: "completed" | "incomplete" | "failed" | "cancelled" | "expired";
	issues: Array<{ code: IssueCode; detail?: string }>;
	durationMs: number;
	model?: string;
	usage?: ModelResponse["usage"];
}
