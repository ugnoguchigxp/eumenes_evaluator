import { randomInt } from "node:crypto";
import { z } from "zod";
import type { EvaluationResult } from "../contracts";
import type { Arm, Case, Trial } from "./suite";

export type Check = { field: string; expected: string; actual: string };
export type RecordedTrial = Trial & {
	runId: string;
	reviewId: string;
	result: EvaluationResult;
	mismatches: Check[];
};
type ScorableTrial = Trial & {
	reviewId: string;
	result: Pick<EvaluationResult, "findings">;
};

export function mismatches(
	item: Case,
	arm: Arm,
	result: EvaluationResult,
): Check[] {
	const differences: Check[] = [];
	const check = (field: string, expected: string, actual: string) => {
		if (expected !== actual) differences.push({ field, expected, actual });
	};
	const baseline = arm === "scoped-quick" || arm === "recheck";
	const expectation =
		(baseline && item.expectedWithoutAdditional) || item.expected;
	check("status", expectation.status, result.status);
	const expected =
		item.selection || arm === "C" || arm === "workflow"
			? expectation.conditions
			: {};
	const actual = new Map(
		result.conditionChecks.map((entry) => [entry.conditionId, entry.status]),
	);
	for (const [id, status] of Object.entries(expected))
		check(id, status, actual.get(id) ?? "missing");
	for (const [id, status] of actual) {
		if (!Object.hasOwn(expected, id)) check(id, "absent", status);
	}
	return differences;
}

function distribution(values: (number | undefined)[]) {
	const sorted = values
		.filter((value): value is number => value !== undefined)
		.sort((a, b) => a - b);
	const percentile = (percent: number) =>
		sorted[Math.ceil(percent * sorted.length) - 1] ?? null;
	return {
		samples: sorted.length,
		median: percentile(0.5),
		p95: percentile(0.95),
	};
}

function byArm<T extends Trial>(trials: T[]) {
	return Map.groupBy(trials, (trial) => trial.arm);
}

export function summarize(trials: RecordedTrial[]) {
	return {
		recorded: trials.length,
		mismatched: trials.filter((trial) => trial.mismatches.length > 0).length,
		arms: Object.fromEntries(
			[...byArm(trials)].map(([arm, rows]) => [
				arm,
				{
					trials: rows.length,
					mismatched: rows.filter((row) => row.mismatches.length > 0).length,
					statuses: Object.fromEntries(
						[...Map.groupBy(rows, (row) => row.result.status)].map(
							([status, matching]) => [status, matching.length],
						),
					),
					findings: rows.reduce(
						(sum, row) => sum + row.result.findings.length,
						0,
					),
					durationMs: distribution(rows.map((row) => row.result.durationMs)),
					inputTokens: distribution(
						rows.map((row) => row.result.usage?.inputTokens),
					),
					outputTokens: distribution(
						rows.map((row) => row.result.usage?.outputTokens),
					),
				},
			]),
		),
	};
}

export function blindReview(trials: RecordedTrial[]) {
	const rows = trials.map((trial) => ({
		reviewId: trial.reviewId,
		caseId: trial.caseId,
		...(trial.result.scopeSelection
			? { selected: trial.result.scopeSelection.selected }
			: {}),
		findings: trial.result.findings.map(
			({ conditionId: _conditionId, ...finding }, index) => ({
				index: index + 1,
				...finding,
			}),
		),
	}));
	for (let index = rows.length - 1; index > 0; index--) {
		const other = randomInt(index + 1);
		[rows[index], rows[other]] = [rows[other]!, rows[index]!];
	}
	return rows;
}

const gradeSchema = z.discriminatedUnion("label", [
	z.strictObject({ label: z.literal("known"), defectId: z.string().min(1) }),
	z.strictObject({
		label: z.enum(["new_valid", "false_positive", "duplicate"]),
	}),
]);
const scoresSchema = z.record(z.string(), z.array(gradeSchema));

export function score(trials: ScorableTrial[], cases: Case[], input: unknown) {
	const scores = scoresSchema.parse(input);
	const guide = new Map(cases.map((item) => [item.id, item]));
	const expectedIds = new Set(trials.map((trial) => trial.reviewId));
	if (Object.keys(scores).some((id) => !expectedIds.has(id)))
		throw new Error("別の実行に属する採点 ID が含まれています");
	const graded = trials.map((trial) => {
		const item = guide.get(trial.caseId)!;
		const grades = scores[trial.reviewId] ?? [];
		if (grades.length !== trial.result.findings.length)
			throw new Error(
				`${trial.reviewId} の指摘 ${trial.result.findings.length} 件をすべて採点してください`,
			);
		const detected = new Set<string>();
		let newValid = 0;
		let falsePositives = 0;
		for (const grade of grades) {
			if (grade.label === "known") {
				if (
					!item.expected.defects.some((defect) => defect.id === grade.defectId)
				) {
					throw new Error(`${trial.reviewId} の既知問題 ID が不正です`);
				}
				detected.add(grade.defectId);
			} else if (grade.label === "new_valid") newValid++;
			else if (grade.label === "false_positive") falsePositives++;
		}
		return {
			...trial,
			detected: [...detected],
			known: item.expected.defects.length,
			newValid,
			falsePositives,
		};
	});
	const arms = Object.fromEntries(
		[...byArm(graded)].map(([arm, rows]) => {
			const total = (select: (row: (typeof rows)[number]) => number) =>
				rows.reduce((sum, row) => sum + select(row), 0);
			const known = total((row) => row.known);
			const detected = total((row) => row.detected.length);
			return [
				arm,
				{
					trials: rows.length,
					known,
					detected,
					recall: known ? detected / known : null,
					newValid: total((row) => row.newValid),
					falsePositives: total((row) => row.falsePositives),
					trialsWithFalsePositives: rows.filter((row) => row.falsePositives > 0)
						.length,
				},
			];
		}),
	);
	const pairs = [
		["A", "B"],
		["B", "C"],
		["D", "C"],
		["scoped-quick", "standard"],
		["context-quick", "standard"],
		["recheck", "standard"],
	] as const;
	const paired = Object.fromEntries(
		pairs.map(([before, after]) => {
			const changes = cases.flatMap((item) => {
				const left = graded.filter(
					(row) => row.caseId === item.id && row.arm === before,
				);
				const right = graded.filter(
					(row) => row.caseId === item.id && row.arm === after,
				);
				const rightByRepeat = new Map(right.map((row) => [row.repeat, row]));
				const matched = left.filter((row) => rightByRepeat.has(row.repeat));
				if (!matched.length) return [];
				const leftHits = (id: string) =>
					matched.filter((row) => row.detected.includes(id)).length;
				const rightHits = (id: string) =>
					matched.filter((row) =>
						rightByRepeat.get(row.repeat)!.detected.includes(id),
					).length;
				const majority = (count: number) => count > matched.length / 2;
				return item.expected.defects.map(({ id }) => ({
					caseId: item.id,
					defectId: id,
					pairedRepeats: matched.length,
					before: majority(leftHits(id)),
					after: majority(rightHits(id)),
				}));
			});
			return [
				`${before}->${after}`,
				{
					improved: changes.filter((row) => !row.before && row.after).length,
					regressed: changes.filter((row) => row.before && !row.after).length,
					unchanged: changes.filter((row) => row.before === row.after).length,
					cases: changes,
				},
			];
		}),
	);
	return { arms, paired };
}
