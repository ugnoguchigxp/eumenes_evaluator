import { createHash } from "node:crypto";
import type {
	EvaluationRequest,
	ExcludedCondition,
	Evidence,
	Location,
	ReviewEvidence,
	Target,
} from "./contracts";

export function fingerprint(value: unknown): string {
	const json = JSON.stringify(value, (_key, item: unknown) => {
		if (item === null || typeof item !== "object" || Array.isArray(item))
			return item;
		const entries = Object.entries(item).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		return Object.fromEntries(entries);
	});
	return createHash("sha256").update(json).digest("hex");
}

export function targetDigests(
	target: Omit<Extract<Target, { kind: "code" }>, "digest" | "diffDigest">,
): {
	digest: string;
	diffDigest: string;
};
export function targetDigests(
	target: Omit<Extract<Target, { kind: "workflow" }>, "digest">,
): {
	digest: string;
};
export function targetDigests(
	target:
		| Omit<Extract<Target, { kind: "code" }>, "digest" | "diffDigest">
		| Omit<Extract<Target, { kind: "workflow" }>, "digest">,
) {
	if (target.kind === "workflow")
		return { digest: fingerprint(target.document) };
	return {
		digest: fingerprint({
			base: target.base,
			head: target.head,
			changes: target.changes,
		}),
		diffDigest: fingerprint(target.changes),
	};
}

export function targetEvidence(target: Target): Evidence[] {
	if (target.kind === "workflow") {
		return [
			{
				id: "workflow",
				kind: "json",
				version: target.version,
				document: target.document,
				clipped: false,
			},
		];
	}
	return target.changes.flatMap((change) => {
		const sides: Evidence[] = [];
		if (change.before)
			sides.push({
				id: `${change.id}:base`,
				kind: "lines",
				path: change.previousPath ?? change.path,
				side: "base",
				version: target.base,
				clipped: false,
				...change.before,
			});
		if (change.after)
			sides.push({
				id: `${change.id}:head`,
				kind: "lines",
				path: change.path,
				side: "head",
				version: target.head,
				clipped: false,
				...change.after,
			});
		return sides;
	});
}

export function activeConditions(request: EvaluationRequest) {
	const { conditions, target } = request;
	const excluded: ExcludedCondition[] = [];
	const entries =
		conditions.state === "available"
			? conditions.entries.filter((entry) => {
					let reason: ExcludedCondition["reason"];
					if (entry.status !== "confirmed") reason = "not_confirmed";
					else if (
						entry.appliesTo.id !== target.id ||
						entry.appliesTo.version !== target.version ||
						entry.appliesTo.digest !== target.digest
					)
						reason = "target_mismatch";
					else if (entry.sources.some((source) => !source.active))
						reason = "source_inactive";
					else return true;
					excluded.push({ id: entry.id, reason });
					return false;
				})
			: [];
	return { entries, excluded };
}

type JsonValue = Extract<Evidence, { kind: "json" }>["document"];

export function pointerTokens(pointer: string): string[] | undefined {
	if (pointer === "") return [];
	if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) return;
	return pointer
		.slice(1)
		.split("/")
		.map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function readPointer(
	value: JsonValue,
	tokens: string[],
): JsonValue | undefined {
	for (const key of tokens) {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) return;
		if (!Object.hasOwn(value, key)) return;
		value = (value as Record<string, JsonValue>)[key]!;
	}
	return value;
}

export function excerptLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

export function locationExists(
	evidence: ReadonlyMap<string, ReviewEvidence>,
	location: Location,
): boolean {
	const item = evidence.get(location.evidenceId);
	if (!item) return false;
	if (item.kind === "json") {
		if (
			location.startLine !== null ||
			location.endLine !== null ||
			location.pointer === null
		)
			return false;
		const tokens = pointerTokens(location.pointer);
		const root = "pointerRoot" in item ? pointerTokens(item.pointerRoot)! : [];
		return (
			!!tokens &&
			root.every((key, index) => tokens[index] === key) &&
			readPointer(item.document, tokens.slice(root.length)) !== undefined
		);
	}
	const { startLine, endLine, pointer } = location;
	const length = excerptLines(item.text).length;
	return (
		pointer === null &&
		startLine !== null &&
		endLine !== null &&
		startLine >= item.startLine &&
		endLine >= startLine &&
		endLine < item.startLine + length
	);
}
