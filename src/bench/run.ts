import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelOutputSchema, type EvaluationModel } from "../contracts";
import { evaluate } from "../evaluate";
import {
	investigationSchema,
	investigationInstructions,
	standardEvidenceInstructions,
	verificationInstructions,
	verificationOutputSchema,
	type ReviewStage,
} from "../investigation";
import { rubricInstructions, scopedReviewInstructions } from "../rubrics";
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
		endpointHost?: string;
		codexSdk?: {
			model: EvaluationModel;
			version: string;
			bare?: {
				model: EvaluationModel;
				promptDigest: string;
				reasoningEffort: "low";
			};
		};
		repeats: number;
		output: string;
		signal: AbortSignal;
		progress?: (trial: RecordedTrial) => void;
	},
) {
	const { output, model, modelId, repeats, signal, progress } = options;
	const planned = schedule(cases, repeats);
	const needsBare = planned.some(({ arm }) => arm === "codex-bare");
	const needsSdk = needsBare || planned.some(({ arm }) => arm === "codex-sdk");
	const sdk = needsSdk ? options.codexSdk : undefined;
	if ((needsSdk && !sdk) || (needsBare && !sdk?.bare))
		throw new Error("codex-sdk 構成には SDK の接続設定が必要です");
	const inputs = new Map(cases.map((item) => [item.id, item]));
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output);
	const metadata = {
		formatVersion: 2,
		runId: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
		model: modelId,
		endpointHost: options.endpointHost,
		...(sdk
			? {
					codexSdk: {
						version: sdk.version,
						model: modelId,
						outputTokenLimit: "provider-default",
						...(sdk.bare
							? {
									comparison: "sdk-only",
									reasoningEffort: sdk.bare.reasoningEffort,
									barePromptDigest: sdk.bare.promptDigest,
								}
							: {}),
					},
				}
			: {}),
		repeats,
		planned: planned.length,
		suiteDigest: fingerprint(cases),
		outputSchemaDigest: fingerprint(modelOutputSchema.toJSONSchema()),
		...(cases.some((item) => item.selection)
			? {
					instructions: {
						scoped: fingerprint(scopedReviewInstructions),
						investigation: fingerprint(investigationInstructions),
						verification: fingerprint(verificationInstructions),
						standardEvidence: fingerprint(standardEvidenceInstructions),
					},
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
	const rawJournal = join(output, "raw.jsonl");
	await writeFile(rawJournal, "", { mode: 0o600 });
	await Bun.write(journal, "");
	const trials: RecordedTrial[] = [];
	const parallelism = sdk ? 3 : 2;
	for (
		let index = 0;
		index < planned.length && !signal.aborted;
		index += parallelism
	) {
		const batch = await Promise.all(
			planned.slice(index, index + parallelism).map(async (trial) => {
				const item = inputs.get(trial.caseId)!;
				const trialModel =
					trial.arm === "codex-bare"
						? sdk!.bare!.model
						: sdk && (sdk.bare || trial.arm === "codex-sdk")
							? sdk.model
							: model;
				const reviewId = crypto.randomUUID();
				const settings = trialOptions(item, trial.arm);
				const raw: {
					reviewId: string;
					phase: ReviewStage["phase"];
					text: string;
				}[] = [];
				let calls = 0;
				const result = await evaluate(trialInput(item, trial.arm), {
					...settings,
					model: {
						async complete(invocation, signal) {
							const phase =
								settings.depth && calls === 0
									? "investigation"
									: "verification";
							calls++;
							const response = await trialModel.complete(invocation, signal);
							raw.push({ reviewId, phase, text: response.text });
							return response;
						},
					},
					signal,
				});
				const record = {
					...trial,
					runId: metadata.runId,
					reviewId,
					result,
					mismatches: mismatches(item, trial.arm, result),
				};
				return { record, raw };
			}),
		);
		for (const { record: trial, raw } of batch) {
			if (raw.length)
				await appendFile(
					rawJournal,
					raw.map((entry) => JSON.stringify(entry) + "\n").join(""),
				);
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
