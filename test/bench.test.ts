import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelOutput } from "../src";
import { loadScorableRun } from "../src/bench/archive";
import { score, type RecordedTrial } from "../src/bench/report";
import { runSuite } from "../src/bench/run";
import { loadSuite, readJson, schedule } from "../src/bench/suite";

const path = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url));
const suite = () => loadSuite(path("../examples/suite.json"));

test("配布スイートの全入力・採点根拠を検証し、同一差分で訂正前後を比較できる", async () => {
	const cases = await suite();
	expect(cases).toHaveLength(9);
	expect(schedule(cases, 3)).toHaveLength(69);
	const first = cases.find((item) => item.id === "batch-limit")!;
	const corrected = cases.find((item) => item.id === "batch-corrected")!;
	expect(corrected.input.target.digest).toBe(first.input.target.digest);
	expect(first.expected.conditions).toEqual({ "max-batch-size": "violated" });
	expect(corrected.expected.conditions).toEqual({ "new-cap": "satisfied" });
	expect(schedule([first], 2).map(({ arm }) => arm)).toEqual([
		"A",
		"B",
		"C",
		"D",
		"B",
		"C",
		"D",
		"A",
	]);
});

test("範囲と深度を含む新版の完全な記録も予定入力に照合できる", async () => {
	const [item] = await loadSuite(path("../examples/depth-suite.json"));
	if (!item) throw new Error("missing depth case");
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-depth-archive-"));
	const output = join(temporary, "run");
	try {
		await runSuite([item], {
			output,
			modelId: "fixture",
			repeats: 1,
			signal: new AbortController().signal,
			model: {
				async complete({ prompt, outputSchema }) {
					const { scope, evidenceCatalog } = JSON.parse(prompt) as {
						scope: string[];
						evidenceCatalog?: Array<{ id: string }>;
					};
					const text = evidenceCatalog
						? {
								hypotheses: [],
								openQuestions: [],
								requests: evidenceCatalog.map(({ id }) => ({
									evidenceId: id,
									question: "関連資料を確認する",
								})),
							}
						: {
								findings: [],
								conditionChecks: [],
								scopeChecks: scope.map((evidenceId) => ({
									evidenceId,
									status: "checked",
									reason: null,
								})),
								...("questionChecks" in (outputSchema.properties ?? {})
									? { questionChecks: [] }
									: {}),
							};
					return { text: JSON.stringify(text) };
				},
			},
		});
		const { cases, trials } = await loadScorableRun(output);
		expect(trials.map(({ arm }) => arm)).toEqual([
			"scoped-quick",
			"context-quick",
			"recheck",
			"standard",
		]);
		expect(score(trials, cases, {}).arms.standard).toMatchObject({
			trials: 1,
			detected: 0,
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("検証結果を保存し、構成を伏せた指摘から検出率・誤指摘を集計する", async () => {
	const [item] = await suite();
	if (!item) throw new Error("missing case");
	const response = (await readJson(
		path("../examples/code-response.json"),
	)) as ModelOutput;
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-bench-"));
	const output = join(temporary, "run");
	try {
		const summary = await runSuite([item], {
			output,
			modelId: "fixture",
			repeats: 1,
			signal: new AbortController().signal,
			model: {
				async complete({ prompt }) {
					const packet = JSON.parse(prompt) as {
						conditions: unknown[];
						originalRequest?: string;
					};
					if (packet.conditions.length)
						return { text: JSON.stringify(response) };
					const findings = packet.originalRequest
						? [
								{
									...response.findings[0]!,
									conditionId: null,
								},
							]
						: [];
					return {
						text: JSON.stringify({
							...response,
							findings,
							conditionChecks: [],
						}),
					};
				},
			},
		});
		expect(summary).toMatchObject({
			planned: 4,
			recorded: 4,
			mismatched: 0,
			interrupted: false,
		});
		const journal = await Bun.file(join(output, "trials.jsonl")).text();
		const trials = journal
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as RecordedTrial);
		const review = (await readJson(join(output, "review.json"))) as object[];
		expect(review).toHaveLength(4);
		for (const row of review) {
			expect(Object.keys(row).sort()).toEqual([
				"caseId",
				"findings",
				"reviewId",
			]);
			expect(JSON.stringify(row)).not.toContain('"conditionId"');
		}
		const c = trials.find((trial) => trial.arm === "C")!.reviewId;
		const d = trials.find((trial) => trial.arm === "D")!.reviewId;
		expect(await readJson(join(output, "scores.template.json"))).toEqual({
			[c]: [null],
			[d]: [null],
		});
		expect(() =>
			score(trials, [item], {
				[c]: [{ label: "known", defectId: "wrong-case" }],
			}),
		).toThrow();
		const graded = score(trials, [item], {
			[c]: [{ label: "known", defectId: "batch-over-limit" }],
			[d]: [{ label: "false_positive" }],
		});
		expect(graded.arms.C).toMatchObject({
			known: 1,
			detected: 1,
			recall: 1,
			falsePositives: 0,
		});
		expect(graded.arms.D).toMatchObject({ detected: 0, falsePositives: 1 });
		expect(graded.paired["B->C"]).toMatchObject({ improved: 1, regressed: 0 });
		const grades = join(temporary, "grades.json");
		await Bun.write(
			grades,
			JSON.stringify({
				[c]: [{ label: "known", defectId: "batch-over-limit" }],
				[d]: [{ label: "false_positive" }],
			}),
		);
		const scoreArchive = () =>
			Bun.spawnSync(
				[process.execPath, "src/bench/cli.ts", "score", output, grades],
				{ cwd: path("..") },
			);
		const complete = scoreArchive();
		expect(complete.exitCode).toBe(0);
		expect(JSON.parse(complete.stdout.toString())).toEqual(graded);
		const [first, second, ...rest] = journal.trim().split("\n");
		for (const [records, error] of [
			[[first], "試行記録が揃っていません"],
			[[first, first, ...rest], "重複した試行記録"],
			[
				[
					JSON.stringify({ ...trials[0], runId: crypto.randomUUID() }),
					second,
					...rest,
				],
				"別の実行の試行記録",
			],
			[
				[
					JSON.stringify({
						...trials[0],
						result: { ...trials[0]!.result, inputDigest: "f".repeat(64) },
					}),
					second,
					...rest,
				],
				"予定入力が一致しません",
			],
		] as const) {
			await Bun.write(join(output, "trials.jsonl"), records.join("\n") + "\n");
			const rejected = scoreArchive();
			expect(rejected.exitCode).toBe(1);
			expect(rejected.stdout.toString()).toBe("");
			expect(rejected.stderr.toString()).toContain(error);
		}
		await Bun.write(join(output, "trials.jsonl"), journal);
		await Bun.write(
			join(output, "summary.json"),
			JSON.stringify({ ...summary, interrupted: true }),
		);
		const interrupted = scoreArchive();
		expect(interrupted.exitCode).toBe(1);
		expect(interrupted.stderr.toString()).toContain(
			"中断した実行は採点できません",
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
