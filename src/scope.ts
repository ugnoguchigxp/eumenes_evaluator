import { z } from "zod";
import type { ReviewDepth } from "./investigation";
import {
	digest,
	id,
	line,
	MAX_SCOPE_CHECKS,
	path,
	side,
	type EvaluationRequest,
	type Evidence,
	type IssueCode,
	type ReviewEvidence,
} from "./contracts";
import {
	activeConditions,
	excerptLines,
	fingerprint,
	pointerTokens,
	readPointer,
	targetEvidence,
} from "./snapshot";

const ids = z
	.array(id)
	.max(1024)
	.refine((values) => new Set(values).size === values.length);
const selectors = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("file"), path }),
	z.strictObject({ kind: z.literal("directory"), path }),
	z
		.strictObject({
			kind: z.literal("lines"),
			path,
			side,
			startLine: line,
			endLine: line,
		})
		.refine((value) => value.startLine <= value.endLine),
	z.strictObject({
		kind: z.literal("pointer"),
		pointer: z
			.string()
			.max(2048)
			.refine((value) => pointerTokens(value) !== undefined),
	}),
]);
export const scopeSelectionSchema = z.strictObject({
	version: z.literal(1),
	targetId: id,
	targetVersion: id,
	targetDigest: digest,
	include: z.array(selectors).min(1).max(256),
	conditionIds: ids.default([]),
	focus: z.string().min(1).max(4000).optional(),
	evidence: z
		.strictObject({
			initial: ids.default([]),
			allowed: ids.default([]),
			required: ids.default([]),
		})
		.default({ initial: [], allowed: [], required: [] }),
});

export type ScopeSelection = z.input<typeof scopeSelectionSchema>;
type Selector = z.infer<typeof selectors>;
type LineEvidence = Extract<Evidence, { kind: "lines" }>;
type Range = { startLine: number; endLine: number };

export function evidenceCoordinates(item: ReviewEvidence) {
	const { id, kind, version, clipped } = item;
	return item.kind === "lines"
		? {
				id,
				kind,
				version,
				clipped,
				path: item.path,
				side: item.side,
				startLine: item.startLine,
				endLine: item.startLine + excerptLines(item.text).length - 1,
			}
		: {
				id,
				kind,
				version,
				clipped,
				pointerRoot: "pointerRoot" in item ? item.pointerRoot : "",
			};
}

function intersection(
	item: LineEvidence,
	end: number,
	selector: Selector,
): Range | undefined {
	if (selector.kind === "pointer") return;
	if (
		selector.kind === "directory"
			? !item.path.startsWith(selector.path + "/")
			: item.path !== selector.path
	)
		return;
	if (selector.kind !== "lines")
		return { startLine: item.startLine, endLine: end };
	if (selector.side !== item.side) return;
	const startLine = Math.max(item.startLine, selector.startLine);
	const endLine = Math.min(end, selector.endLine);
	if (startLine <= endLine) return { startLine, endLine };
}

function projectCode(primary: LineEvidence[], include: Selector[]) {
	const matched = new Set<number>();
	const projected = primary.flatMap((item) => {
		const lines = excerptLines(item.text);
		const end = item.startLine + lines.length - 1;
		const ranges = include
			.flatMap((selector, index) => {
				const range = intersection(item, end, selector);
				if (!range) return [];
				matched.add(index);
				return [range];
			})
			.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
		const merged: Range[] = [];
		for (const range of ranges) {
			const previous = merged.at(-1);
			if (previous && range.startLine <= previous.endLine + 1)
				previous.endLine = Math.max(previous.endLine, range.endLine);
			else merged.push(range);
		}
		return merged.map(({ startLine, endLine }) => {
			if (startLine === item.startLine && endLine === end) return item;
			const from = startLine - item.startLine;
			const to = endLine - item.startLine + 1;
			return {
				...item,
				id: "lines:" + fingerprint([item.id, startLine, endLine]),
				startLine,
				text:
					lines.slice(from, to).join("\n") +
					(to < lines.length || item.text.endsWith("\n") ? "\n" : ""),
			};
		});
	});
	return {
		projected,
		missing: include.flatMap((_, i) => (matched.has(i) ? [] : [i])),
	};
}

function projectWorkflow(
	target: Extract<EvaluationRequest["target"], { kind: "workflow" }>,
	include: Selector[],
) {
	const missing: number[] = [];
	const seen = new Set<string>();
	const selected = include.flatMap((selector, index) => {
		if (selector.kind !== "pointer") {
			missing.push(index);
			return [];
		}
		const tokens = pointerTokens(selector.pointer)!;
		const document = readPointer(target.document, tokens);
		if (document === undefined) {
			missing.push(index);
			return [];
		}
		if (seen.has(selector.pointer)) return [];
		seen.add(selector.pointer);
		return [{ pointer: selector.pointer, tokens, document }];
	});
	const projected: ReviewEvidence[] = selected
		.filter(
			(item) =>
				!selected.some(
					(other) =>
						other.tokens.length < item.tokens.length &&
						other.tokens.every((token, i) => token === item.tokens[i]),
				),
		)
		.map(({ pointer, document }) => ({
			id: pointer === "" ? "workflow" : "json:" + fingerprint(pointer),
			kind: "json",
			version: target.version,
			document,
			pointerRoot: pointer,
			clipped: false,
		}));
	return { projected, missing };
}

export class ScopeError extends Error {
	constructor(
		readonly code: IssueCode,
		detail?: string,
	) {
		super(detail ?? code);
	}
}

export function resolveScope(request: EvaluationRequest, input: unknown) {
	const parsed = scopeSelectionSchema.safeParse(input);
	if (!parsed.success)
		throw new ScopeError(
			"invalid_scope_selection",
			parsed.error.issues
				.slice(0, 6)
				.map((issue) => issue.path.join("."))
				.join(", "),
		);
	const selection = parsed.data;
	if (
		selection.targetDigest !== request.target.digest ||
		selection.targetId !== request.target.id ||
		selection.targetVersion !== request.target.version
	)
		throw new ScopeError("scope_target_mismatch");
	const { target } = request;
	if (
		selection.include.some(
			(selector) =>
				(selector.kind === "pointer") !== (target.kind === "workflow"),
		)
	) {
		throw new ScopeError("scope_selector_target_mismatch");
	}
	const { projected, missing } =
		target.kind === "code"
			? projectCode(
					targetEvidence(target).filter(
						(item): item is LineEvidence => item.kind === "lines",
					),
					selection.include,
				)
			: projectWorkflow(target, selection.include);
	if (missing.length)
		throw new ScopeError(
			"scope_selector_no_match",
			missing.map((i) => `include[${i}]`).join(", "),
		);
	const { initial, allowed, required } = selection.evidence;
	const permitted = new Set([...initial, ...allowed]);
	const initialIds = new Set(initial);
	if (required.some((key) => !permitted.has(key)))
		throw new ScopeError("scope_evidence_not_allowed");
	if (projected.some((item) => permitted.has(item.id)))
		throw new ScopeError("scope_evidence_id_conflict");
	const catalog = [...targetEvidence(target), ...request.evidence].filter(
		(item) => permitted.has(item.id),
	);
	const initialEvidence = catalog.filter((item) => initialIds.has(item.id));
	const availableIds = new Set(catalog.map((item) => item.id));
	const present = new Set(initialEvidence.map((item) => item.id));
	const scopeIds = [
		...new Set([
			...projected.map((item) => item.id),
			...required,
			...initial.filter((key) => !present.has(key)),
		]),
	];
	if (scopeIds.length > MAX_SCOPE_CHECKS)
		throw new ScopeError(
			"scope_size_limit",
			`確認対象 ${scopeIds.length} 件は上限 ${MAX_SCOPE_CHECKS} 件を超えています`,
		);
	const eligible = new Set(
		activeConditions(request).entries.map((item) => item.id),
	);
	const unavailableConditions = selection.conditionIds.filter(
		(key) => !eligible.has(key),
	);
	const { conditions } = request;
	const selectedConditions =
		selection.conditionIds.length === 0
			? null
			: conditions.state === "available"
				? {
						...conditions,
						entries: conditions.entries.filter((entry) =>
							selection.conditionIds.includes(entry.id),
						),
					}
				: conditions;
	const scopeSnapshot = {
		selection,
		evidence: catalog.map((item) => [item.id, fingerprint(item)]),
	};
	const conditionDigest = fingerprint(selectedConditions);
	return {
		primary: projected,
		initialEvidence,
		catalog,
		scopeIds,
		unavailableConditions,
		focus: selection.focus,
		// Only used to validate archives created before conditions were bound to the preview.
		legacyDigest: fingerprint(scopeSnapshot),
		summary: {
			version: selection.version,
			digestVersion: 2 as const,
			digest: fingerprint({
				...scopeSnapshot,
				conditionDigest,
				rubric: request.rubric,
				originalRequest: request.originalRequest,
			}),
			conditionDigest,
			conditionRevision:
				selectedConditions?.state === "available"
					? selectedConditions.revision
					: null,
			targetDigest: target.digest,
			target: {
				kind: target.kind,
				id: target.id,
				version: target.version,
				...(target.kind === "code"
					? { base: target.base, head: target.head }
					: {}),
			},
			selected: projected.map(evidenceCoordinates),
			initialEvidenceIds: initial,
			allowedEvidenceIds: [...permitted],
			availableEvidence: catalog.map(evidenceCoordinates),
			unknownEvidenceIds: [...permitted].filter((id) => !availableIds.has(id)),
			requiredEvidenceIds: required,
			conditionIds: selection.conditionIds,
			unavailableConditionIds: unavailableConditions,
		},
	};
}

export type ResolvedScope = ReturnType<typeof resolveScope>;

export function evaluationInputDigest(
	request: EvaluationRequest,
	scope: ResolvedScope | undefined,
	depth: ReviewDepth = "quick",
	formatVersion: 1 | 2 = 2,
): string {
	return scope
		? fingerprint({
				request,
				scopeDigest:
					formatVersion === 1 ? scope.legacyDigest : scope.summary.digest,
				depth,
			})
		: fingerprint(request);
}
