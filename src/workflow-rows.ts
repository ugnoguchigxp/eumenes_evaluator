import { z } from "zod";
import {
	id,
	modelOutputSchema,
	MAX_SCOPE_CHECKS,
	type Location,
	type ModelOutput,
	type ReviewEvidence,
} from "./contracts";
import { locationExists, pointerTokens, readPointer } from "./snapshot";

const pointer = z.string().max(2048);
const reason = z.string().min(1).max(1000);
const value = z.string().max(500);
const rowReference = z.strictObject({ row: pointer, value });
const comparable = z.union([z.number(), z.string().max(64)]);
const maxComparisons = 8;
const basisComparison = z.strictObject({
	left: comparable,
	op: z.enum(["lt", "lte", "eq", "gte", "gt"]),
	right: comparable,
	holds: z.boolean(),
});
const basisDecision = z.strictObject({
	comparison: z
		.int()
		.min(0)
		.max(maxComparisons - 1),
	when: z.boolean(),
	value,
});
const comparisonHolds = {
	lt: (left: number, right: number) => left < right,
	lte: (left: number, right: number) => left <= right,
	eq: (left: number, right: number) => left === right,
	gte: (left: number, right: number) => left >= right,
	gt: (left: number, right: number) => left > right,
};
const clockTime = z.iso.time();
const timestamp = z.union([
	z.iso.datetime({ offset: true, precision: -1 }),
	z.iso.datetime({ offset: true }),
]);
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function numericValue(value: number | string): number | undefined {
	if (typeof value === "number") return value;
	if (decimal.test(value)) {
		const parsed = Number(value);
		if (Math.abs(parsed) <= Number.MAX_SAFE_INTEGER) return parsed;
	}
}

function comparisonAgrees({
	left,
	op,
	right,
	holds,
}: z.infer<typeof basisComparison>) {
	const compare = comparisonHolds[op];
	const leftNumber = numericValue(left);
	const rightNumber = numericValue(right);
	if (leftNumber !== undefined || rightNumber !== undefined)
		return (
			leftNumber !== undefined &&
			rightNumber !== undefined &&
			compare(leftNumber, rightNumber) === holds
		);
	if (typeof left !== "string" || typeof right !== "string") return false;
	const clock =
		clockTime.safeParse(left).success && clockTime.safeParse(right).success;
	if (
		!clock &&
		(!timestamp.safeParse(left).success || !timestamp.safeParse(right).success)
	)
		return false;
	const first = timeParts(left, clock);
	const second = timeParts(right, clock);
	if (!Number.isFinite(first.whole) || !Number.isFinite(second.whole))
		return false;
	const order =
		first.whole === second.whole
			? Number(first.fraction > second.fraction) -
				Number(first.fraction < second.fraction)
			: Math.sign(first.whole - second.whole);
	return compare(order, 0) === holds;
}

function timeParts(time: string, clock: boolean) {
	// Keep fractional seconds separate from Date.parse's millisecond resolution.
	const fraction = (time.match(/\.(\d+)/)?.[1] ?? "").replace(/0+$/, "");
	const wholeTime = time.replace(/\.\d+/, "");
	if (!clock) return { whole: Date.parse(wholeTime), fraction };
	const [hour, minute, second = 0] = wholeTime.split(":").map(Number);
	return { whole: hour! * 3600 + minute! * 60 + second, fraction };
}

const evidence = z
	.array(z.strictObject({ evidenceId: id, pointer: pointer.nullable() }))
	.max(12);
const rowOutput = z.strictObject({
	rows: z
		.array(
			z.strictObject({
				pointer,
				evidence,
				basis: z.strictObject({
					// Allow omissions here so only the affected rows are marked unverified.
					comparisons: basisComparison.array().max(maxComparisons).optional(),
					decision: basisDecision.nullable().optional(),
					dependencies: rowReference.array().max(32).optional(),
					facts: reason,
					value: value.nullable(),
					via: rowReference.nullable(),
				}),
				conditionId: id.nullable(),
			}),
		)
		.max(MAX_SCOPE_CHECKS),
	conditions: z
		.array(
			z.strictObject({
				conditionId: id,
				verified: z.boolean(),
				reason,
				evidence,
			}),
		)
		.max(1000),
});

export function workflowRowSchema(
	comparisonPointers: string[],
	evidenceIds: string[],
	expectedValues?: string[],
) {
	const citation = evidence.element.extend({ evidenceId: z.enum(evidenceIds) });
	const row = rowOutput.shape.rows.element;
	const expected = expectedValues ? z.enum(expectedValues) : value;
	const dependency = rowReference.extend({
		row: z.enum(comparisonPointers),
		value: expected,
	});
	return rowOutput
		.extend({
			rows: row
				.extend({
					pointer: z.enum(comparisonPointers),
					evidence: citation.array().max(12),
					basis: row.shape.basis.extend({
						comparisons: basisComparison.array().max(maxComparisons),
						decision: basisDecision.extend({ value: expected }).nullable(),
						dependencies: dependency.array().max(32),
						value: expected.nullable(),
						via: dependency.nullable(),
					}),
				})
				.array()
				.max(MAX_SCOPE_CHECKS),
			conditions: rowOutput.shape.conditions.element
				.extend({
					evidence: citation.array().max(12),
				})
				.array()
				.max(1000),
		})
		.toJSONSchema();
}

export const workflowRowInstructions = [
	"comparisonPointers は現行値が記録された欄の絶対位置です。この一覧の値を rows の pointer に一度ずつ使ってください。primaryEvidenceIds は対応する行の資料です。",
	"基準時刻・台帳・確認済み記録・依存先など、evidence にある関連資料を横断して期待値を求めてください。依存先や先行行も確定条件から再計算し、現行値を計算の根拠に使わないでください。",
	"時刻の照合では比較する値を同じ時間帯にそろえ、条件に定められた境界の等号を確認してください。依存による停止は指定順で確認し、直前に求めた各依存先の結果と照合してください。",
	'判定を左右する数値・時刻の比較は basis.comparisons に入れてください。left/right は同じ単位の数値、同日・同じ時間帯の時刻（HH:MM）、またはタイムゾーン付きのISO日時です。op（lt <、lte ≤、eq =、gte ≥、gt >）は確認した条件、holds はその条件が成立するなら true、不成立なら false です。例えば12:00は12:00未満かは left="12:00", op="lt", right="12:00", holds=false です。判定が決まった後の比較は省いてください。該当なしは空配列です。',
	"行の最終判定が数値・時刻の比較で決まる場合は、basis.decision に判定を決めた比較の番号（comparison、先頭は0）、その判定になるために必要な真偽（when）、規則が定める判定値（value）を記載します。記録の採否や前提条件の通過に使った比較は comparisons に記載し、別の理由で最終判定が決まる場合は decision を null にします。",
	"basis.dependencies には、通過した行も含め、判定に使った別行の欄の絶対位置 row とその期待値 value を記載してください。先に依存先を確定し、現行値を転記せずその期待値を使用します。参照する行がなければ空配列です。",
	"basis.facts に、基準時刻などを代入した具体的な照合結果を記載してください。その結果から判定欄に入る期待値を basis.value に一度だけ記載してください。判定欄がコードならコードを、内訳も記録する欄なら内訳まで同じ表記で返してください。根拠IDや依存連鎖は判定欄の値に含めません。",
	"expectedValues がある場合、判定欄の値はその一覧から選びます。",
	"別の行の判定が停止などの決め手になる場合は、basis.via.row に直接の依存先の欄の絶対位置を comparisonPointers から一つ選び、basis.via.value にその依存先の期待値を記載してください。連鎖全体は書かず、各行で直接の依存先だけを指定します。直接の依存先が決め手でなければ via は null です。",
	"evidence では期待値の計算に使った資料を引用してください。現行値の欄は引用不要です。evidenceId には資料の ID、pointer にはその資料の document のルートからの JSON Pointer を入れてください。document 直下の項目なら /項目名 です。pointerRoot や資料IDを前に足す必要はありません。資料全体を引用する場合は null を使ってください。",
	"必要な資料を確認できない場合は basis.value を null とし、不足を facts に記載してください。適用条件に反する行では、差を説明する conditionId を指定してください。それ以外は null にしてください。",
	"選択された各条件を conditions に一度ずつ記載し、適用結果を確かめた場合だけ verified を true にし、根拠位置を添えてください。focus は確認時の着眼点です。",
].join("\n");

export function workflowRowOutput(
	json: unknown,
	selected: ReviewEvidence[],
	materials: ReadonlyMap<string, ReviewEvidence>,
	scope: ReadonlySet<string>,
	currentValuePointer: string,
	conditionIds: string[],
	rowLabelPointer?: string,
	expectedValues?: string[],
): ModelOutput | undefined {
	const parsed = rowOutput.safeParse(json);
	if (!parsed.success) return;
	const rows = new Map(
		selected.flatMap((item) =>
			item.kind === "json" && "pointerRoot" in item
				? [[item.pointerRoot + currentValuePointer, item] as const]
				: [],
		),
	);
	if (parsed.data.rows.some((row) => !rows.has(row.pointer))) return;
	const byPointer = Map.groupBy(parsed.data.rows, (row) => row.pointer);
	const findings: ModelOutput["findings"] = [];
	const cited = new Set<string>();
	function locations(refs: z.infer<typeof evidence>): Location[] | undefined {
		const result: Location[] = [];
		for (const { evidenceId, pointer } of refs) {
			const item = materials.get(evidenceId);
			if (item?.kind !== "json" || item.clipped) return;
			if (pointer !== null && pointerTokens(pointer) === undefined) return;
			const root = "pointerRoot" in item ? item.pointerRoot : "";
			// Also accept existing absolute references when they identify the same
			// selected material unambiguously.
			const candidates = new Set(
				pointer === null ? [root] : [root + pointer, pointer],
			);
			const matching = [...candidates]
				.filter((candidate) => candidate.length <= 2048)
				.map((pointer) => ({
					evidenceId,
					pointer,
					startLine: null,
					endLine: null,
				}))
				.filter((location) => locationExists(materials, location));
			if (matching.length !== 1) return;
			result.push(matching[0]!);
		}
		if (result.length) return result;
	}
	const tokens = pointerTokens(currentValuePointer)!;
	const labelTokens =
		rowLabelPointer === undefined ? undefined : pointerTokens(rowLabelPointer)!;
	const labels = new Map(
		[...rows].map(([pointer, item]) => [
			pointer,
			labelTokens
				? (readPointer(item.document, labelTokens) as string)
				: pointer,
		]),
	);
	const checkedRows = new Map<
		string,
		{
			expected: string;
			supporting: Location[];
			basis: {
				dependencies: z.infer<typeof rowReference>[];
				via: z.infer<typeof rowReference> | null;
				facts: string;
			};
			conditionId: string | null;
		}
	>();
	const issues = new Map<string, string>();
	for (const [pointer, matches] of byPointer) {
		const row = matches[0]!;
		const { comparisons, decision, dependencies, facts, value, via } =
			row.basis;
		const supporting = locations(row.evidence);
		if (matches.length !== 1)
			issues.set(pointer, "同じ行の判定が複数返りました");
		else if (
			comparisons === undefined ||
			decision === undefined ||
			dependencies === undefined
		)
			issues.set(pointer, "比較・判定規則・依存先の必須欄が揃っていません");
		else if (value === null) issues.set(pointer, facts);
		else if (expectedValues && !expectedValues.includes(value))
			issues.set(pointer, "期待値が指定された判定値の一覧にありません");
		else if (comparisons.some((comparison) => !comparisonAgrees(comparison)))
			issues.set(pointer, "判定の根拠として示した比較の成否が一致しません");
		else if (
			decision &&
			(comparisons[decision.comparison]?.holds !== decision.when ||
				decision.value !== value)
		)
			issues.set(pointer, "比較結果に基づく判定規則と期待値が一致しません");
		else if (!supporting)
			issues.set(pointer, "期待値を裏付ける根拠位置を確認できませんでした");
		else if (
			row.conditionId !== null &&
			!conditionIds.includes(row.conditionId)
		)
			issues.set(pointer, "適用対象の条件を参照していません");
		else
			checkedRows.set(pointer, {
				basis: { dependencies, facts, via },
				conditionId: row.conditionId,
				expected: value,
				supporting,
			});
	}
	const verified = new Map<string, boolean>();
	const visiting = new Set<string>();
	function dependenciesVerified(pointer: string): boolean {
		const previous = verified.get(pointer);
		if (previous !== undefined) return previous;
		const basis = checkedRows.get(pointer)?.basis;
		if (!basis || visiting.has(pointer)) return false;
		visiting.add(pointer);
		const references = [
			...basis.dependencies,
			...(basis.via ? [basis.via] : []),
		];
		const valid = references.every(
			({ row, value }) =>
				checkedRows.get(row)?.expected === value && dependenciesVerified(row),
		);
		visiting.delete(pointer);
		verified.set(pointer, valid);
		return valid;
	}
	function chain(pointer: string): string[] {
		const hops: string[] = [];
		let via = checkedRows.get(pointer)?.basis.via;
		while (via) {
			hops.push(labels.get(via.row)!);
			via = checkedRows.get(via.row)?.basis.via;
		}
		return hops;
	}
	const scopeChecks: ModelOutput["scopeChecks"] = [];
	for (const [pointer, item] of rows) {
		const row = checkedRows.get(pointer);
		const hops =
			row && dependenciesVerified(pointer) ? chain(pointer) : undefined;
		const current = readPointer(item.document, tokens) as string;
		const chainText = hops?.join(">");
		if (!row || !hops || (chainText && chainText.length > 1000)) {
			if (!byPointer.has(pointer)) continue;
			scopeChecks.push({
				evidenceId: item.id,
				status: "unverified",
				reason:
					issues.get(pointer) ?? "依存先の判定または連鎖を確認できませんでした",
			});
			continue;
		}
		const explanation = chainText ? "依存連鎖 " + chainText : row.basis.facts;
		scopeChecks.push({
			evidenceId: item.id,
			status: "checked",
			reason: explanation,
		});
		for (const ref of row.supporting) cited.add(ref.evidenceId);
		if (row.expected !== current)
			findings.push({
				title: "現行値と期待値の差異",
				problem: `現行値: ${current}\n期待値: ${row.expected}\n根拠: ${explanation}`,
				trigger: "固定資料と確定条件を適用したとき",
				impact: "現行値を使う後続作業に差異が引き継がれます",
				severity: "medium",
				primary: {
					evidenceId: item.id,
					pointer,
					startLine: null,
					endLine: null,
				},
				evidence: row.supporting,
				conditionId: row.conditionId,
			});
	}
	const violations = Map.groupBy(findings, (finding) => finding.conditionId);
	const conditionChecks: ModelOutput["conditionChecks"] =
		parsed.data.conditions.map((check) => {
			const references = locations(check.evidence);
			const violatedRows = violations.get(check.conditionId);
			if (!check.verified || !references)
				return {
					conditionId: check.conditionId,
					status: "unverified",
					reason: check.verified
						? "条件の根拠位置を確認できませんでした"
						: check.reason,
					evidence: [],
				};
			for (const ref of references) cited.add(ref.evidenceId);
			return {
				conditionId: check.conditionId,
				status: violatedRows ? "violated" : "satisfied",
				reason: check.reason,
				evidence:
					violatedRows?.slice(0, 12).map(({ primary }) => primary) ??
					references,
			};
		});
	for (const evidenceId of cited) {
		if (
			scope.has(evidenceId) &&
			!selected.some((item) => item.id === evidenceId)
		)
			scopeChecks.push({
				evidenceId,
				status: "checked",
				reason: "照合の根拠を参照しました",
			});
	}
	const output = modelOutputSchema.safeParse({
		findings,
		scopeChecks,
		conditionChecks,
	});
	if (output.success) return output.data;
}
