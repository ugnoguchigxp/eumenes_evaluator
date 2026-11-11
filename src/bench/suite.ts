import { isAbsolute, relative, resolve, dirname } from "node:path";
import { z } from "zod";
import {
	MAX_INPUT_BYTES,
	locationSchema,
	requestSchema,
	type EvaluationRequest,
} from "../contracts";
import { evaluate } from "../evaluate";
import { readText } from "../read-text";
import { scopeSelectionSchema, type ScopeSelection } from "../scope";
import {
	comparisonArms,
	comparisonRequest,
	type ComparisonArm,
} from "../rubrics";
import { activeConditions, locationExists, targetEvidence } from "../snapshot";

const defectSchema = z.strictObject({
	id: z.string().min(1),
	description: z.string().min(1),
	severity: z.enum(["critical", "high", "medium", "low"]),
	evidence: locationSchema,
});
const expectationSchema = z.strictObject({
	status: z.enum(["completed", "incomplete"]),
	conditions: z.record(
		z.string(),
		z.enum(["satisfied", "violated", "unverified"]),
	),
});
const depthArms = [
	"scoped-quick",
	"context-quick",
	"recheck",
	"standard",
] as const;
const caseSchema = z.strictObject({
	id: z.string().regex(/^[a-z0-9-]+$/),
	group: z.string().min(1),
	request: z.string().min(1),
	arms: z.array(z.enum(comparisonArms)).min(1).max(4).optional(),
	scope: z.string().min(1).optional(),
	expected: expectationSchema.extend({ defects: z.array(defectSchema) }),
	expectedWithoutAdditional: expectationSchema.optional(),
	notes: z.string().min(1),
});
const suiteSchema = z.strictObject({
	version: z.literal(1),
	cases: z.array(caseSchema).min(1),
});
export type Case = z.infer<typeof caseSchema> & {
	input: EvaluationRequest;
	selection?: ScopeSelection;
};
export const archivedCasesSchema = z
	.array(
		caseSchema.extend({
			input: requestSchema,
			selection: scopeSelectionSchema.optional(),
		}),
	)
	.min(1);
export type Arm = ComparisonArm | "workflow" | (typeof depthArms)[number];
export type Trial = { caseId: string; arm: Arm; repeat: number };

export async function readJson(
	path: string,
	limit = MAX_INPUT_BYTES,
): Promise<unknown> {
	return JSON.parse(await readText(Bun.file(path).stream(), limit));
}

function assertUnique(items: string[], message: string) {
	if (new Set(items).size !== items.length) throw new Error(message);
}

async function checkCase(item: Case) {
	const { id, input, arms, expected } = item;
	const workflow = input.target.kind === "workflow";
	if (item.selection ? !!arms : workflow === !!arms)
		throw new Error(`${id} の比較構成が対象の種類と一致しません`);
	assertUnique(arms ?? [], `${id} の比較構成が重複しています`);
	assertUnique(
		expected.defects.map((defect) => defect.id),
		`${id} の既知の問題 ID が重複しています`,
	);
	const locations = new Map(
		[...targetEvidence(input.target), ...input.evidence].map((entry) => [
			entry.id,
			entry,
		]),
	);
	for (const defect of expected.defects) {
		if (!locationExists(locations, defect.evidence))
			throw new Error(`${id}/${defect.id} の採点根拠を参照できません`);
	}
	const active = activeConditions(input).entries.filter(
		(entry) =>
			!item.selection || item.selection.conditionIds?.includes(entry.id),
	);
	const keys = Object.keys(expected.conditions);
	if (
		active.length !== keys.length ||
		active.some((entry) => !Object.hasOwn(expected.conditions, entry.id))
	) {
		throw new Error(`${id} の有効な条件と期待値の ID が一致しません`);
	}
	if (
		item.expectedWithoutAdditional &&
		(!item.selection ||
			active.some(
				(entry) =>
					!Object.hasOwn(item.expectedWithoutAdditional!.conditions, entry.id),
			) ||
			Object.keys(item.expectedWithoutAdditional.conditions).length !==
				active.length)
	) {
		throw new Error(`${id} の追加資料なしの期待値が有効な条件と一致しません`);
	}
	for (const arm of caseArms(item)) {
		const request = trialInput(item, arm);
		let called = false;
		const result = await evaluate(request, {
			...trialOptions(item, arm),
			model: {
				async complete(invocation) {
					called = true;
					const fields = invocation.outputSchema.properties ?? {};
					return {
						text: JSON.stringify(
							"requests" in fields
								? {
										hypotheses: [],
										openQuestions: [],
										requests: [],
									}
								: {
										findings: [],
										scopeChecks: [],
										conditionChecks: [],
										...("questionChecks" in fields
											? { questionChecks: [] }
											: {}),
									},
						),
					};
				},
			},
		});
		if (!called || result.status !== "incomplete") {
			throw new Error(
				`${id}/${arm} の入力が無効です (${result.issues.map((issue) => issue.code).join(", ")})`,
			);
		}
	}
}

async function readSuiteFile(directory: string, file: string) {
	const filePath = resolve(directory, file);
	const withinSuite = relative(directory, filePath);
	if (
		!withinSuite ||
		withinSuite === ".." ||
		withinSuite.startsWith("../") ||
		isAbsolute(file)
	) {
		throw new Error(`スイート内の相対パスを指定してください (${file})`);
	}
	return readJson(filePath);
}

export async function loadSuite(path: string): Promise<Case[]> {
	const suite = suiteSchema.parse(await readJson(path));
	assertUnique(
		suite.cases.map((item) => item.id),
		"ケース ID が重複しています",
	);
	const directory = dirname(resolve(path));
	const cases: Case[] = [];
	for (const item of suite.cases) {
		const input = requestSchema.parse(
			await readSuiteFile(directory, item.request),
		);
		const selection = item.scope
			? scopeSelectionSchema.parse(await readSuiteFile(directory, item.scope))
			: undefined;
		const loaded = { ...item, input, selection };
		await checkCase(loaded);
		cases.push(loaded);
	}
	return cases;
}

export function trialInput(item: Case, arm: Arm): EvaluationRequest {
	return arm === "A" || arm === "B" || arm === "C" || arm === "D"
		? comparisonRequest(item.input, arm)
		: item.input;
}

export function trialOptions(item: Case, arm: Arm) {
	const selection = item.selection;
	if (!selection) return {};
	if (arm === "context-quick") {
		const initial = [
			...new Set([
				...(selection.evidence?.initial ?? []),
				...(selection.evidence?.allowed ?? []),
			]),
		];
		return {
			selection: { ...selection, evidence: { ...selection.evidence, initial } },
		};
	}
	return {
		selection,
		depth: arm === "recheck" || arm === "standard" ? arm : undefined,
	};
}

function caseArms(item: Case): readonly Arm[] {
	return item.selection ? depthArms : (item.arms ?? ["workflow"]);
}

export function schedule(cases: Case[], repeats: number): Trial[] {
	const trials: Trial[] = [];
	for (let repeat = 1; repeat <= repeats; repeat++) {
		for (const item of cases) {
			const arms = caseArms(item);
			// Rotate which comparison arm runs first on each repeat.
			const offset = (repeat - 1) % arms.length;
			for (const arm of [...arms.slice(offset), ...arms.slice(0, offset)]) {
				trials.push({ caseId: item.id, arm, repeat });
			}
		}
	}
	return trials;
}
