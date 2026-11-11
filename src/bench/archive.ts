import { join } from "node:path";
import { z } from "zod";
import { digest, id, modelOutputSchema } from "../contracts";
import { readText } from "../read-text";
import { evaluationInputDigest, resolveScope } from "../scope";
import { fingerprint } from "../snapshot";
import {
	archivedCasesSchema,
	readJson,
	schedule,
	trialInput,
	trialOptions,
} from "./suite";

const runSchema = z.object({
	formatVersion: z.union([z.literal(1), z.literal(2)]),
	runId: z.uuid().optional(),
	planned: z.int().positive(),
	repeats: z.int().positive(),
	suiteDigest: digest,
});
const summarySchema = runSchema.extend({
	recorded: z.int().nonnegative(),
	interrupted: z.boolean(),
	finishedAt: z.iso.datetime(),
});
const trialSchema = z.object({
	caseId: id,
	arm: id,
	repeat: z.int().positive(),
	reviewId: id,
	runId: z.uuid().optional(),
	result: z.object({
		...modelOutputSchema.pick({ findings: true }).shape,
		contractVersion: z.literal(1),
		evaluationId: id,
		inputDigest: digest,
		status: z.enum([
			"completed",
			"incomplete",
			"failed",
			"expired",
			"cancelled",
		]),
	}),
});

function trialKey(trial: {
	caseId: string;
	arm: string;
	repeat: number;
}): string {
	return JSON.stringify([trial.caseId, trial.arm, trial.repeat]);
}

export async function loadScorableRun(directory: string) {
	const maxBytes = 64 * 1024 * 1024;
	const [rawCases, rawRun, rawSummary, journal] = await Promise.all([
		readJson(join(directory, "cases.json"), maxBytes),
		readJson(join(directory, "run.json"), maxBytes),
		readJson(join(directory, "summary.json"), maxBytes),
		readText(Bun.file(join(directory, "trials.jsonl")).stream(), maxBytes),
	]);
	const run = runSchema.parse(rawRun);
	const summary = summarySchema.parse(rawSummary);
	if (summary.interrupted) throw new Error("中断した実行は採点できません");
	if (run.formatVersion === 2 && (!run.runId || run.runId !== summary.runId))
		throw new Error("完了記録が実行 ID と一致しません");
	const cases = archivedCasesSchema.parse(rawCases);
	if (
		fingerprint(rawCases) !== run.suiteDigest ||
		summary.suiteDigest !== run.suiteDigest ||
		summary.formatVersion !== run.formatVersion ||
		summary.repeats !== run.repeats ||
		summary.planned !== run.planned
	) {
		throw new Error("実行記録とスイートの識別情報が一致しません");
	}

	const lines = journal.trim().split("\n").filter(Boolean);
	const caseById = new Map(cases.map((item) => [item.id, item]));
	if (
		caseById.size !== cases.length ||
		schedule(cases, 1).length * run.repeats !== run.planned
	)
		throw new Error("スイートと予定試行の集合が一致しません");
	if (summary.recorded !== run.planned || lines.length !== run.planned)
		throw new Error(
			`試行記録が揃っていません (予定 ${run.planned}、記録 ${lines.length})`,
		);

	const pending = new Map(
		schedule(cases, run.repeats).map((trial) => [trialKey(trial), trial]),
	);
	const reviewIds = new Set<string>();
	const trials = lines.map((line) => {
		const record = trialSchema.parse(JSON.parse(line));
		if (run.formatVersion === 2 && record.runId !== run.runId)
			throw new Error("別の実行の試行記録が含まれています");
		const key = trialKey(record);
		const trial = pending.get(key);
		if (!trial || reviewIds.has(record.reviewId))
			throw new Error(
				`予定外または重複した試行記録です (${record.caseId}/${record.arm}/${record.repeat})`,
			);
		pending.delete(key);
		reviewIds.add(record.reviewId);
		if (record.result.status === "cancelled")
			throw new Error("取り消された試行を含む実行は採点できません");
		const item = caseById.get(trial.caseId)!;
		const request = trialInput(item, trial.arm);
		const { selection, depth } = trialOptions(item, trial.arm);
		const resolved =
			selection === undefined ? undefined : resolveScope(request, selection);
		if (
			record.result.evaluationId !== request.evaluationId ||
			record.result.inputDigest !==
				evaluationInputDigest(request, resolved, depth, run.formatVersion)
		) {
			throw new Error(
				`試行記録と予定入力が一致しません (${record.caseId}/${record.arm}/${record.repeat})`,
			);
		}
		return { ...trial, reviewId: record.reviewId, result: record.result };
	});
	return { cases, trials };
}
