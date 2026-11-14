import { expect, spyOn, test } from "bun:test";
import { Codex } from "@openai/codex-sdk";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	evaluate,
	fingerprint,
	type EvaluationModel,
	type ModelRequest,
	type ModelOutput,
} from "../src";
import {
	investigationInstructions,
	standardEvidenceInstructions,
	verificationInstructions,
} from "../src/investigation";
import { scopedReviewInstructions } from "../src/rubrics";
import { loadScorableRun } from "../src/bench/archive";
import { bareReviewRequest, codexSdkLunaModel } from "../src/bench/codex-sdk";
import { score, type RecordedTrial } from "../src/bench/report";
import { runSuite } from "../src/bench/run";
import {
	loadSuite,
	readJson,
	schedule,
	trialInput,
	trialOptions,
	withCodexSdk,
} from "../src/bench/suite";

const path = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url));
const suite = () => loadSuite(path("../examples/suite.json"));

test("Codex SDK は通常と bare の両方で SKILL をユーザー入力として送る", async () => {
	const [item] = await suite();
	const skillMarkdown = "# 確認手順\n\n変更前後の操作結果を照合する。";
	const startThread = spyOn(Codex.prototype, "startThread");
	const originalKey = Bun.env.OPEN_AI_API_KEY;
	Bun.env.OPEN_AI_API_KEY = "fixture";
	const sent: unknown[] = [];
	startThread.mockImplementation((() => ({
		async runStreamed(prompt: unknown) {
			sent.push(prompt);
			return {
				events: (async function* () {
					yield {
						type: "item.completed",
						item: {
							type: "agent_message",
							text: JSON.stringify({
								findings: [],
								scopeChecks: [],
								conditionChecks: [],
							}),
						},
					};
					yield {
						type: "turn.completed",
						usage: { input_tokens: 10, output_tokens: 5 },
					};
				})(),
			};
		},
	})) as typeof Codex.prototype.startThread);
	try {
		for (const bare of [false, true]) {
			const { model } = codexSdkLunaModel({ bare });
			const result = await evaluate(
				{ ...item!.input, skillMarkdown },
				{ model },
			);
			expect(result.model).toBe("gpt-6-luna");
		}
		expect(sent).toHaveLength(2);
		const [normal, bare] = sent as string[];
		expect(JSON.parse(normal!).skillMarkdown).toBe(skillMarkdown);
		expect(bare).toBe(`${bareReviewRequest}\n\n${normal}`);
	} finally {
		startThread.mockRestore();
		if (originalKey === undefined) delete Bun.env.OPEN_AI_API_KEY;
		else Bun.env.OPEN_AI_API_KEY = originalKey;
	}
});

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

test("スイート検査は選択した条件の欠落を扱い、最終判定に届かない入力を拒否する", async () => {
	const [fixture] = await loadSuite(path("../examples/depth-suite.json"));
	const material = fixture?.input.evidence[0];
	if (!fixture?.selection || material?.kind !== "lines")
		throw new Error("missing fixture");
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-suite-preflight-"));
	try {
		const suiteFile = join(temporary, "suite.json");
		const request = join(temporary, "request.json");
		const input = fixture.input;
		material.text += "// " + "a".repeat(8000) + "\n";
		const selection = { ...fixture.selection, conditionIds: ["missing"] };
		const expected = {
			...fixture.expected,
			status: "incomplete",
			conditions: { missing: "unverified" },
		};
		await Promise.all([
			Bun.write(request, JSON.stringify(input)),
			Bun.write(join(temporary, "scope.json"), JSON.stringify(selection)),
			Bun.write(
				suiteFile,
				JSON.stringify({
					version: 1,
					cases: [
						{
							id: fixture.id,
							group: fixture.group,
							notes: fixture.notes,
							request: "request.json",
							scope: "scope.json",
							depthArms: ["standard"],
							expected,
							expectedWithoutAdditional: {
								status: expected.status,
								conditions: expected.conditions,
							},
						},
					],
				}),
			),
		]);
		expect(await loadSuite(suiteFile)).toHaveLength(1);
		input.limits.maxInputBytes = 5000;
		await Bun.write(request, JSON.stringify(input));
		await expect(loadSuite(suiteFile)).rejects.toThrow("prompt_size_limit");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("複数の補足資料を使う比較は、同じ範囲と依頼で二構成を実行する", async () => {
	const cases = await loadSuite(path("../examples/multi-evidence-suite.json"));
	expect(cases).toHaveLength(6);
	expect(schedule(cases, 3)).toHaveLength(36);
	for (const item of cases) {
		const quick = trialOptions(item, "context-quick").selection!;
		const standard = trialOptions(item, "standard").selection!;
		const evidence = standard.evidence;
		if (!evidence?.allowed)
			throw new Error(`${item.id} の許可資料がありません`);
		expect(evidence.allowed.length).toBeGreaterThan(1);
		expect(quick).toEqual({
			...standard,
			evidence: { ...evidence, initial: evidence.allowed },
		});
		expect(evidence.initial).toEqual([]);
		expect(evidence.required).toEqual([]);
		expect(trialInput(item, "context-quick")).toBe(
			trialInput(item, "standard"),
		);
		expect(schedule([item], 2).map(({ arm }) => arm)).toEqual([
			"context-quick",
			"standard",
			"standard",
			"context-quick",
		]);
	}
});

test("調整用と最終評価用を分離し、最終評価の三群と訂正・撤回をそろえる", async () => {
	const [calibration, final] = await Promise.all([
		loadSuite(path("../examples/calibration-suite.json")),
		loadSuite(path("../examples/final-suite.json")),
	]);
	expect(calibration).toHaveLength(6);
	expect(schedule(final, 3)).toHaveLength(216);
	const calibrationIds = new Set(calibration.map(({ id }) => id));
	expect(final.some(({ id }) => calibrationIds.has(id))).toBe(false);
	const groups = Map.groupBy(final, ({ group }) => group);
	expect([...groups].map(([group, cases]) => [group, cases.length])).toEqual([
		["code-regression", 6],
		["condition-regression", 6],
		["normal-change", 6],
	]);
	for (const group of ["condition-regression", "normal-change"]) {
		const statuses = groups
			.get(group)!
			.flatMap(({ input }) =>
				input.conditions.state === "available"
					? input.conditions.entries.map(({ status }) => status)
					: [],
			);
		expect(statuses).toContain("withdrawn");
		expect(statuses).toContain("superseded");
	}
});

test("SDK は資料先渡しQuickと同じ推論入力を別の接続で受け取り、採点にも残る", async () => {
	const baseline = await loadSuite(
		path("../examples/multi-evidence-suite.json"),
	);
	const compared = withCodexSdk(baseline);
	expect(schedule(baseline, 3)).toHaveLength(36);
	expect(schedule(compared, 3)).toHaveLength(54);
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-sdk-comparison-"));
	const output = join(temporary, "run");
	try {
		const sdkInputs: ModelRequest[] = [];
		const httpInputs: ModelRequest[] = [];
		const model = (inputs: ModelRequest[]): EvaluationModel => ({
			async complete(invocation) {
				inputs.push(invocation);
				const result = JSON.parse(invocation.prompt).evidenceCatalog
					? { hypotheses: [], openQuestions: [], requests: [] }
					: { findings: [], scopeChecks: [], conditionChecks: [] };
				return { text: JSON.stringify(result) };
			},
		});
		const options = {
			output,
			model: model(httpInputs),
			modelId: "fixture",
			repeats: 1,
			signal: new AbortController().signal,
		};
		await expect(runSuite(compared.slice(0, 1), options)).rejects.toThrow(
			"SDK の接続設定が必要",
		);
		expect(httpInputs).toEqual([]);
		const summary = await runSuite(compared.slice(0, 1), {
			...options,
			codexSdk: { model: model(sdkInputs), version: "fixture-sdk" },
		});
		expect(summary.codexSdk?.version).toBe("fixture-sdk");
		expect(sdkInputs).toHaveLength(1);
		expect(httpInputs).toHaveLength(3);
		expect(sdkInputs[0]).toEqual(httpInputs[0]);
		const { cases, trials } = await loadScorableRun(output);
		expect(trials.map(({ arm }) => arm)).toEqual([
			"context-quick",
			"standard",
			"codex-sdk",
		]);
		expect(trials[2]?.result.inputDigest).toBe(trials[0]?.result.inputDigest);
		const scores = score(trials, cases, {});
		expect(scores.paired["context-quick->codex-sdk"].cases).toHaveLength(1);
		expect(scores.paired["standard->codex-sdk"].cases).toHaveLength(1);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("SDK low 比較は三構成を SDK に送り、素のCodexとQuickに同じ資料を渡す", async () => {
	const cases = withCodexSdk(
		await loadSuite(path("../examples/multi-evidence-suite.json")),
		"sdk-low",
	);
	expect(schedule(cases, 3)).toHaveLength(54);
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-sdk-low-"));
	try {
		const quickAndStandard: ModelRequest[] = [];
		const bare: ModelRequest[] = [];
		const fixture = (requests: ModelRequest[]): EvaluationModel => ({
			async complete(invocation) {
				requests.push(invocation);
				const body = JSON.parse(invocation.prompt);
				return {
					text: JSON.stringify(
						body.evidenceCatalog
							? { hypotheses: [], openQuestions: [], requests: [] }
							: { findings: [], scopeChecks: [], conditionChecks: [] },
					),
				};
			},
		});
		const output = join(temporary, "run");
		const summary = await runSuite(cases.slice(0, 1), {
			output,
			model: {
				async complete() {
					throw new Error("unexpected fallback");
				},
			},
			modelId: "fixture",
			codexSdk: {
				version: "fixture-sdk",
				model: fixture(quickAndStandard),
				bare: {
					model: fixture(bare),
					promptDigest: "fixture",
					reasoningEffort: "low",
				},
			},
			repeats: 1,
			signal: new AbortController().signal,
		});
		expect(summary.codexSdk).toMatchObject({
			comparison: "sdk-only",
			reasoningEffort: "low",
		});
		expect(quickAndStandard).toHaveLength(3);
		expect(bare).toEqual([quickAndStandard[0]]);
		const run = await loadScorableRun(output);
		expect(run.trials.map(({ arm }) => arm)).toEqual([
			"context-quick",
			"standard",
			"codex-bare",
		]);
		expect(run.trials[0]?.result.inputDigest).toBe(
			run.trials[2]?.result.inputDigest,
		);
		expect(
			score(run.trials, run.cases, {}).paired["codex-bare->context-quick"]
				.cases,
		).toHaveLength(1);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
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
		const run = await Bun.file(join(output, "run.json")).json();
		expect(run.instructions.standardEvidence).toBe(
			fingerprint(standardEvidenceInstructions),
		);
		for (const [name, text] of Object.entries({
			scoped: scopedReviewInstructions,
			investigation: investigationInstructions,
			verification: verificationInstructions,
		})) {
			expect(run.instructions[name]).toBe(fingerprint(text));
			expect(run.instructions[name]).not.toBe(fingerprint(text + "."));
		}
		const raw = (await Bun.file(join(output, "raw.jsonl")).text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const { cases, trials } = await loadScorableRun(output);
		const standard = trials.find((trial) => trial.arm === "standard")!;
		expect(
			raw
				.filter((row) => row.reviewId === standard.reviewId)
				.map((row) => row.phase),
		).toEqual(["investigation", "verification"]);
		await rm(join(output, "raw.jsonl"));
		expect((await loadScorableRun(output)).trials).toHaveLength(4);
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
		if (process.platform !== "win32")
			expect((await stat(output)).mode & 0o077).toBe(0);
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
			caseIds: [item.id],
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
		for (const [change, error] of [
			[{ runId: crypto.randomUUID() }, "実行 ID と一致しません"],
			[{ suiteDigest: "f".repeat(64) }, "識別情報が一致しません"],
			[{ planned: summary.planned + 1 }, "識別情報が一致しません"],
		] as const) {
			await Bun.write(
				join(output, "summary.json"),
				JSON.stringify({ ...summary, ...change }),
			);
			await expect(loadScorableRun(output)).rejects.toThrow(error);
		}
		await Bun.write(join(output, "summary.json"), JSON.stringify(summary));
		const runPath = join(output, "run.json");
		const metadata = await Bun.file(runPath).text();
		await Bun.write(
			runPath,
			JSON.stringify({ ...JSON.parse(metadata), planned: summary.planned + 1 }),
		);
		await Bun.write(
			join(output, "summary.json"),
			JSON.stringify({ ...summary, planned: summary.planned + 1 }),
		);
		await expect(loadScorableRun(output)).rejects.toThrow(
			"予定試行の集合が一致しません",
		);
		await Bun.write(runPath, metadata);
		await Bun.write(join(output, "summary.json"), JSON.stringify(summary));
		const [first, second, ...rest] = journal.trim().split("\n");
		for (const [records, error] of [
			[[first], "試行記録が揃っていません"],
			[[first, first, ...rest], "重複した試行記録"],
			[
				[
					JSON.stringify({
						...trials[0],
						result: { ...trials[0]!.result, status: "cancelled" },
					}),
					second,
					...rest,
				],
				"取り消された試行",
			],
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
			await expect(loadScorableRun(output)).rejects.toThrow(error);
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

test("スイート外を指すリンクとディレクトリを依頼ファイルとして拒否する", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-suite-path-"));
	try {
		const inside = join(temporary, "suite");
		await mkdir(inside);
		const outside = join(temporary, "outside.json");
		await Bun.write(outside, Bun.file(path("../examples/code-request.json")));
		const suitePath = join(inside, "suite.json");
		const [item] = (await Bun.file(path("../examples/suite.json")).json())
			.cases;
		await symlink(outside, join(inside, "escape.json"));
		await mkdir(join(inside, "directory.json"));
		for (const request of ["escape.json", "directory.json"]) {
			await Bun.write(
				suitePath,
				JSON.stringify({ version: 1, cases: [{ ...item, request }] }),
			);
			await expect(loadSuite(suitePath)).rejects.toThrow(
				"スイート内の通常ファイル",
			);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("bench CLI は指定モデルで実行し、生出力と失敗の内訳を保存する", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-bench-model-"));
	const output = join(temporary, "run");
	const submitted: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { model } = (await request.json()) as { model: string };
			submitted.push(model);
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			return Response.json({
				choices: [
					{ finish_reason: "stop", message: { content: "malformed fixture" } },
				],
			});
		},
	});
	try {
		const args = [
			process.execPath,
			"src/bench/cli.ts",
			"run",
			"--case",
			"workflow-team",
			"--endpoint",
			server.url.href,
			"--model",
			"fixture-model",
			"--out",
			output,
		];
		const options = {
			cwd: path(".."),
			env: { ...process.env, EVALUATOR_API_KEY: "fixture" },
			stdout: "pipe",
			stderr: "pipe",
		} as const;
		const mixed = Bun.spawn([...args, "--openai"], options);
		expect(await mixed.exited).toBe(1);
		expect(submitted).toEqual([]);
		const run = Bun.spawn(args, options);
		expect(await run.exited).toBe(2);
		expect(submitted).toEqual(["fixture-model"]);
		const metadata = await Bun.file(join(output, "run.json")).json();
		expect(metadata).toMatchObject({
			model: "fixture-model",
			endpointHost: "127.0.0.1",
		});
		const summary = await Bun.file(join(output, "summary.json")).json();
		expect(summary.arms.workflow).toMatchObject({
			issues: { invalid_model_output: 1 },
			rejected: 0,
		});
		const [{ reviewId, findings }] = await Bun.file(
			join(output, "review.json"),
		).json();
		expect(findings).toEqual([]);
		const raw = JSON.parse(await Bun.file(join(output, "raw.jsonl")).text());
		expect(raw).toEqual({
			reviewId,
			phase: "verification",
			text: "malformed fixture",
		});
		expect(await Bun.file(join(output, "scores.template.json")).json()).toEqual(
			{},
		);
	} finally {
		server.stop(true);
		await rm(temporary, { recursive: true, force: true });
	}
});
