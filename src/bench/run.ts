import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelOutputSchema, type EvaluationModel } from "../contracts";
import { evaluate } from "../evaluate";
import {
	investigationSchema,
	verificationOutputSchema,
} from "../investigation";
import { rubricInstructions } from "../rubrics";
import { fingerprint } from "../snapshot";
import {
	blindReview,
	mismatches,
	summarize,
	type RecordedTrial,
} from "./report";
import { schedule, trialInput, trialOptions, type Case } from "./suite";

export const writeJson = (path: string, value: unknown) =>
	Bun.write(path, JSON.stringify(value, null, "\t") + "\n");

export async function runSuite(
	cases: Case[],
	options: {
		model: EvaluationModel;
		modelId: string;
		repeats: number;
		output: string;
		signal: AbortSignal;
		progress?: (trial: RecordedTrial) => void;
	},
) {
	const { output, model, modelId, repeats, signal, progress } = options;
	const planned = schedule(cases, repeats);
	const inputs = new Map(cases.map((item) => [item.id, item]));
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output);
	const metadata = {
		formatVersion: 2,
		runId: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
		model: modelId,
		repeats,
		planned: planned.length,
		suiteDigest: fingerprint(cases),
		outputSchemaDigest: fingerprint(modelOutputSchema.toJSONSchema()),
		...(cases.some((item) => item.selection)
			? {
					investigationSchemaDigest: fingerprint(investigationSchema),
					verificationSchemaDigest: fingerprint(
						verificationOutputSchema.toJSONSchema(),
					),
				}
			: {}),
		rubrics: Object.fromEntries(
			planned.map(({ caseId, arm }) => {
				const { rubric } = trialInput(inputs.get(caseId)!, arm);
				return [
					rubric.id,
					{
						version: rubric.version,
						digest: fingerprint(rubricInstructions(rubric)),
					},
				];
			}),
		),
	};
	await writeJson(join(output, "run.json"), metadata);
	await writeJson(join(output, "cases.json"), cases);
	const journal = join(output, "trials.jsonl");
	await Bun.write(journal, "");
	const trials: RecordedTrial[] = [];
	for (let index = 0; index < planned.length && !signal.aborted; index += 2) {
		const batch = await Promise.all(
			planned.slice(index, index + 2).map(async (trial) => {
				const item = inputs.get(trial.caseId)!;
				const result = await evaluate(trialInput(item, trial.arm), {
					...trialOptions(item, trial.arm),
					model,
					signal,
				});
				return {
					...trial,
					runId: metadata.runId,
					reviewId: crypto.randomUUID(),
					result,
					mismatches: mismatches(item, trial.arm, result),
				};
			}),
		);
		for (const trial of batch) {
			await appendFile(journal, JSON.stringify(trial) + "\n");
			trials.push(trial);
			progress?.(trial);
		}
	}
	const review = blindReview(trials);
	const summary = {
		...metadata,
		finishedAt: new Date().toISOString(),
		interrupted: signal.aborted,
		...summarize(trials),
	};
	await writeJson(join(output, "review.json"), review);
	await writeJson(
		join(output, "scores.template.json"),
		Object.fromEntries(
			review
				.filter((row) => row.findings.length > 0)
				.map((row) => [row.reviewId, row.findings.map(() => null)]),
		),
	);
	await writeJson(join(output, "summary.json"), summary);
	return summary;
}
