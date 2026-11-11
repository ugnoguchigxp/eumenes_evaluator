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
					facts: reason,
					value: value.nullable(),
					via: z.strictObject({ row: pointer, value }).nullable(),
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
	return rowOutput
		.extend({
			rows: row
				.extend({
					pointer: z.enum(comparisonPointers),
					evidence: citation.array().max(12),
					basis: row.shape.basis.extend({
						value: expected.nullable(),
						via: z
							.strictObject({
								row: z.enum(comparisonPointers),
								value: expected,
							})
							.nullable(),
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
	"basis.facts に、基準時刻などを代入した具体的な照合結果を記載してください。その結果から判定欄に入る期待値を basis.value に一度だけ記載してください。判定欄がコードならコードを、内訳も記録する欄なら内訳まで同じ表記で返してください。根拠IDや依存連鎖は判定欄の値に含めません。",
	"expectedValues がある場合、判定欄の値はその一覧から選びます。",
	"別の行の判定が停止などの決め手になる場合は、basis.via.row に直接の依存先の欄の絶対位置を comparisonPointers から一つ選び、basis.via.value にその依存先の期待値を記載してください。連鎖全体は書かず、各行で直接の依存先だけを指定します。直接の依存先が決め手でなければ via は null です。",
	"evidence では期待値の計算に使った資料だけを引用し、現行値の欄は引用不要です。資料の ID を evidenceId に転記してください。資料全体を使う場合は pointer に null を使います。より細かい位置を示す場合は JSON Pointer を使い、pointerRoot がある資料では元文書上の絶対位置を指定してください。",
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
		const result = refs.map(({ evidenceId, pointer }) => {
			const item = materials.get(evidenceId);
			return {
				evidenceId,
				pointer:
					pointer ?? (item && "pointerRoot" in item ? item.pointerRoot : ""),
				startLine: null,
				endLine: null,
			};
		});
		if (
			!result.length ||
			!result.every(
				(ref) =>
					!materials.get(ref.evidenceId)?.clipped &&
					locationExists(materials, ref),
			)
		)
			return;
		return result;
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
			basis: z.infer<typeof rowOutput>["rows"][number]["basis"];
			conditionId: string | null;
		}
	>();
	const issues = new Map<string, string>();
	for (const [pointer, matches] of byPointer) {
		const row = matches[0]!;
		const supporting = locations(row.evidence);
		if (matches.length !== 1)
			issues.set(pointer, "同じ行の判定が複数返りました");
		else if (row.basis.value === null) issues.set(pointer, row.basis.facts);
		else if (expectedValues && !expectedValues.includes(row.basis.value))
			issues.set(pointer, "期待値が指定された判定値の一覧にありません");
		else if (!supporting)
			issues.set(pointer, "期待値を裏付ける根拠位置を確認できませんでした");
		else if (
			row.conditionId !== null &&
			!conditionIds.includes(row.conditionId)
		)
			issues.set(pointer, "適用対象の条件を参照していません");
		else
			checkedRows.set(pointer, {
				...row,
				expected: row.basis.value,
				supporting,
			});
	}
	function chain(pointer: string): string[] | undefined {
		const seen = new Set([pointer]);
		const hops: string[] = [];
		let via = checkedRows.get(pointer)?.basis.via;
		while (via) {
			const next = via.row;
			const dependency = checkedRows.get(next);
			if (seen.has(next) || dependency?.expected !== via.value) return;
			seen.add(next);
			hops.push(labels.get(next)!);
			via = dependency.basis.via;
		}
		return hops;
	}
	const scopeChecks: ModelOutput["scopeChecks"] = [];
	for (const [pointer, item] of rows) {
		const row = checkedRows.get(pointer);
		const hops = row && chain(pointer);
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
