import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	evaluate,
	previewScope,
	requestSchema,
	targetDigests,
	type EvaluationModel,
	type EvaluationRequest,
	type ModelRequest,
	type ScopeSelection,
} from "../src";

async function code() {
	const fixture = requestSchema.parse(
		await Bun.file(
			new URL("../examples/cases/retry-delay.json", import.meta.url),
		).json(),
	);
	if (fixture.target.kind !== "code") throw new Error("code required");
	const content = {
		...fixture.target,
		changes: [
			{
				id: "move",
				path: "jobs/retry.ts",
				previousPath: "old/retry.ts",
				before: {
					startLine: 7,
					text: "const marker = 'base';\nconst delayMs = delaySeconds * 1000;\n",
				},
				after: {
					startLine: 7,
					text: "const marker = 'head';\nconst delayMs = delaySeconds;\n",
				},
			},
			{
				id: "other",
				path: "jobs-backup/other.ts",
				before: { startLine: 1, text: "unselectedBase\n" },
				after: { startLine: 1, text: "unselectedHead\n" },
			},
		],
	};
	const request: EvaluationRequest = {
		...fixture,
		target: { ...content, ...targetDigests(content) },
		evidence: [
			...fixture.evidence,
			{
				kind: "lines",
				id: "restricted",
				path: "private.ts",
				side: "head",
				version: fixture.target.head,
				startLine: 1,
				text: "private_marker",
				clipped: false,
			},
		],
	};
	const selection: ScopeSelection = {
		version: 1,
		targetId: request.target.id,
		targetVersion: request.target.version,
		targetDigest: request.target.digest,
		include: [
			{
				kind: "lines",
				path: "jobs/retry.ts",
				side: "head",
				startLine: 8,
				endLine: 8,
			},
		],
		evidence: { allowed: ["timer"], required: ["timer"] },
	};
	return { request, selection };
}

function checked(input: ModelRequest) {
	const { scope } = JSON.parse(input.prompt) as { scope: string[] };
	return {
		findings: [],
		conditionChecks: [],
		scopeChecks: scope.map((evidenceId) => ({
			evidenceId,
			status: "checked",
			reason: null,
		})),
	};
}
const response = (value: unknown) => ({
	text: JSON.stringify(value),
	model: "fixture",
	usage: { inputTokens: 10, outputTokens: 7 },
});
const simple: EvaluationModel = {
	async complete(input) {
		return response(checked(input));
	},
};
const investigation = (ids: string[]) => ({
	hypotheses: ["単位が一致しない可能性"],
	openQuestions: ["タイマーの単位"],
	requests: ids.map((evidenceId) => ({
		evidenceId,
		question: "タイマーの単位を確認",
	})),
});

test("範囲指定で行を切り出し、許可外の本文を推論に渡さない", async () => {
	const { request, selection } = await code();
	const summary = previewScope(request, selection);
	expect(summary.selected).toMatchObject([
		{ path: "jobs/retry.ts", side: "head", startLine: 8, endLine: 8 },
	]);
	const result = await evaluate(request, {
		selection,
		model: {
			async complete(input) {
				expect(input.prompt).toContain("const delayMs = delaySeconds;");
				for (const value of [
					"unselectedHead",
					"marker",
					"setTimeout",
					"private_marker",
				]) {
					expect(input.prompt).not.toContain(value);
				}
				return simple.complete(input, new AbortController().signal);
			},
		},
	});
	expect(result.status).toBe("incomplete");
	expect(result.scopeSelection).toEqual(summary);
	expect(
		result.scopeChecks.find((item) => item.evidenceId === "timer")?.status,
	).toBe("unverified");
});

test("ディレクトリ境界、改名前後のパス、空振りと版違いを照合する", async () => {
	const { request, selection } = await code();
	const scope = {
		...selection,
		include: [
			{ kind: "directory", path: "jobs" },
			{ kind: "file", path: "old/retry.ts" },
		],
	};
	const selected = previewScope(request, scope).selected;
	expect(
		selected.map((item) => item.kind === "lines" && [item.path, item.side]),
	).toEqual([
		["old/retry.ts", "base"],
		["jobs/retry.ts", "head"],
	]);
	for (const [bad, code] of [
		[{ ...selection, targetDigest: "f".repeat(64) }, "scope_target_mismatch"],
		[{ ...selection, targetVersion: "other" }, "scope_target_mismatch"],
		[{ ...selection, targetId: "other" }, "scope_target_mismatch"],
		[
			{ ...selection, include: [{ kind: "file", path: "absent.ts" }] },
			"scope_selector_no_match",
		],
	] as const) {
		const result = await evaluate(request, {
			selection: bad,
			model: {
				async complete() {
					throw new Error("must not call");
				},
			},
		});
		expect(result.issues[0]?.code).toBe(code);
	}
});

test("ワークフローでは選択した部分木だけを送り、元文書上の Pointer を検証する", async () => {
	const request = requestSchema.parse(
		await Bun.file(
			new URL("../examples/cases/workflow-team.json", import.meta.url),
		).json(),
	);
	const selection: ScopeSelection = {
		version: 1,
		targetId: request.target.id,
		targetVersion: request.target.version,
		targetDigest: request.target.digest,
		include: [{ kind: "pointer", pointer: "/publish" }],
		conditionIds: ["audience"],
	};
	for (const pointer of ["/publish/audience", "/inputs/dataset", "/audience"]) {
		const result = await evaluate(request, {
			selection,
			model: {
				async complete(input) {
					const packet = JSON.parse(input.prompt);
					expect(packet.evidence).toHaveLength(1);
					expect(packet.evidence[0].document).toEqual({
						kind: "report",
						audience: "team",
					});
					expect(packet.evidence[0].pointerRoot).toBe("/publish");
					return response({
						...checked(input),
						conditionChecks: [
							{
								conditionId: "audience",
								status: "satisfied",
								reason: "team",
								evidence: [
									{
										evidenceId: packet.evidence[0].id,
										startLine: null,
										endLine: null,
										pointer,
									},
								],
							},
						],
					});
				},
			},
		});
		expect(result.status).toBe(
			pointer === "/publish/audience" ? "completed" : "failed",
		);
	}
});

test("Standard は許可資料だけを一回取得し、根拠照合と利用量集計を行う", async () => {
	const { request, selection } = await code();
	const result = await evaluate(request, {
		depth: "standard",
		selection,
		model: {
			async complete(input) {
				const packet = JSON.parse(input.prompt);
				expect(input.prompt).not.toContain("private_marker");
				if ("evidenceCatalog" in packet) {
					expect(
						packet.evidenceCatalog.map((item: { id: string }) => item.id),
					).toEqual(["timer"]);
					expect(input.prompt).not.toContain("setTimeout");
					return response(investigation(["timer", "restricted"]));
				}
				expect(packet.primaryEvidenceIds).toEqual([packet.evidence[0].id]);
				expect(input.prompt).toContain("setTimeout");
				return response({
					...checked(input),
					findings: [
						{
							title: "秒をミリ秒に変換する",
							problem: "単位不一致",
							trigger: "リトライ時",
							impact: "待機が短い",
							severity: "medium",
							primary: {
								evidenceId: packet.evidence[0].id,
								startLine: 8,
								endLine: 8,
								pointer: null,
							},
							evidence: [
								{
									evidenceId: "timer",
									startLine: 9,
									endLine: 9,
									pointer: null,
								},
							],
							conditionId: null,
						},
					],
				});
			},
		},
	});
	expect(result.status).toBe("incomplete");
	expect(result.findings).toHaveLength(1);
	expect(result.issues).toContainEqual({
		code: "investigation_evidence_unavailable",
	});
	expect(result.review?.stages).toMatchObject([
		{
			phase: "investigation",
			status: "completed",
			acquired: ["timer"],
			unavailable: ["restricted"],
		},
		{ phase: "verification", status: "completed" },
	]);
	expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 14 });
});

test("Standard の最終判定が取り消されたら仮説を指摘として返さない", async () => {
	const { request, selection } = await code();
	const controller = new AbortController();
	const result = await evaluate(request, {
		selection,
		depth: "standard",
		signal: controller.signal,
		model: {
			async complete(input) {
				if ("evidenceCatalog" in JSON.parse(input.prompt))
					return response(investigation(["timer"]));
				controller.abort();
				return response(checked(input));
			},
		},
	});
	expect(result.status).toBe("cancelled");
	expect(result.findings).toEqual([]);
	expect(result.review?.stages.at(-1)?.status).toBe("cancelled");
	expect(result.review?.questions[0]).toMatchObject({
		question: "タイマーの単位",
		status: "unverified",
	});
});

test("選択した資料 ID でも選択外の行が主根拠なら拒否する", async () => {
	const { request, selection } = await code();
	const result = await evaluate(request, {
		selection,
		model: {
			async complete(input) {
				const { primaryEvidenceIds } = JSON.parse(input.prompt);
				return response({
					...checked(input),
					findings: [
						{
							title: "選択外の行",
							problem: "問題",
							trigger: "実行時",
							impact: "影響",
							severity: "low",
							primary: {
								evidenceId: primaryEvidenceIds[0],
								startLine: 7,
								endLine: 8,
								pointer: null,
							},
							evidence: [],
							conditionId: null,
						},
					],
				});
			},
		},
	});
	expect(result.status).toBe("failed");
	expect(result.issues).toContainEqual({
		code: "invalid_model_references",
		detail: "finding_location_unavailable",
	});
	expect(result.findings).toEqual([]);
});

async function approvalFixture() {
	const request = requestSchema.parse(
		await Bun.file(
			new URL("../examples/code-request.json", import.meta.url),
		).json(),
	);
	request.evidence.push({
		kind: "json",
		id: "policy",
		version: request.target.version,
		clipped: false,
		document: { limit: 10 },
	});
	const selection: ScopeSelection = {
		version: 1,
		targetId: request.target.id,
		targetVersion: request.target.version,
		targetDigest: request.target.digest,
		include: [{ kind: "file", path: "queue.ts" }],
		conditionIds: ["max-batch-size"],
		evidence: { allowed: ["policy"] },
	};
	return { request, selection };
}

test("プレビューと条件本文・出所・版・許可資料が異なる実行を推論前に拒否する", async () => {
	const { request, selection } = await approvalFixture();
	const { digest: expectedScopeDigest } = previewScope(request, selection);
	if (request.conditions.state !== "available")
		throw new Error("missing fixture conditions");
	const variants = [
		{
			...request,
			conditions: {
				...request.conditions,
				entries: request.conditions.entries.map((item) => ({
					...item,
					text: "上限は20件",
				})),
			},
		},
		{ ...request, conditions: { ...request.conditions, revision: "next" } },
		{
			...request,
			conditions: {
				...request.conditions,
				entries: request.conditions.entries.map((item) => ({
					...item,
					sources: item.sources.map((source) => ({ ...source, version: "2" })),
				})),
			},
		},
		{
			...request,
			evidence: request.evidence.map((item) => ({
				...item,
				document: { limit: 20 },
			})),
		},
	];
	let calls = 0;
	for (const input of variants) {
		expect(previewScope(input, selection).digest).not.toBe(expectedScopeDigest);
		const result = await evaluate(input, {
			selection,
			expectedScopeDigest,
			model: {
				async complete() {
					calls++;
					return response(null);
				},
			},
		});
		expect(result.status).toBe("failed");
		expect(result.issues[0]?.code).toBe("scope_preview_mismatch");
	}
	expect(calls).toBe(0);
});

test("CLI は確認した digest で実行でき、条件変更または digest 省略を拒否する", async () => {
	const { request, selection } = await approvalFixture();
	const root = fileURLToPath(new URL("..", import.meta.url));
	const temp = await mkdtemp(join(tmpdir(), "eumenes-scope-confirm-"));
	const input = join(temp, "request.json");
	const scope = join(temp, "scope.json");
	try {
		await Promise.all([
			Bun.write(input, JSON.stringify(request)),
			Bun.write(scope, JSON.stringify(selection)),
		]);
		const args = [process.execPath, "src/cli.ts", input, "--scope", scope];
		const invoke = (...options: string[]) =>
			Bun.spawnSync([...args, ...options], { cwd: root });
		const preview = invoke("--preview");
		expect(preview.exitCode).toBe(0);
		const approved = JSON.parse(preview.stdout.toString()).digest;
		const fixture = ["--fixture", "examples/code-response.json"];
		expect(invoke(...fixture).exitCode).toBe(1);
		const good = invoke(...fixture, "--expected-scope-digest", approved);
		expect(good.exitCode).toBe(0);
		expect(JSON.parse(good.stdout.toString()).scopeSelection.digest).toBe(
			approved,
		);

		if (request.conditions.state !== "available")
			throw new Error("missing fixture conditions");
		request.conditions.entries[0]!.text = "上限は20件";
		await Bun.write(input, JSON.stringify(request));
		const bad = invoke(...fixture, "--expected-scope-digest", approved);
		expect(bad.exitCode).toBe(1);
		expect(JSON.parse(bad.stdout.toString()).issues[0].code).toBe(
			"scope_preview_mismatch",
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("Standard は未回答と明示的な未確認を残し、許可された根拠付きの解決だけを採用する", async () => {
	const { request, selection } = await code();
	const question = "タイマーに渡る値の単位は何か";
	for (const variant of [
		"omitted",
		"unverified",
		"resolved",
		"outside",
	] as const) {
		const result = await evaluate(request, {
			depth: "standard",
			selection,
			model: {
				async complete(input) {
					const packet = JSON.parse(input.prompt);
					if ("evidenceCatalog" in packet)
						return response({
							...investigation(["timer"]),
							openQuestions: [question],
						});
					expect(packet.investigation.openQuestions).toEqual([
						{ questionId: "question-1", question },
					]);
					expect(input.outputSchema.required).toContain("questionChecks");
					const output = checked(input);
					if (variant === "omitted") return response(output);
					return response({
						...output,
						questionChecks: [
							{
								questionId: "question-1",
								status: variant === "unverified" ? "unverified" : "resolved",
								reason:
									variant === "unverified"
										? "資料不足"
										: "setTimeout の引数を確認",
								evidence:
									variant === "unverified"
										? []
										: [
												{
													evidenceId:
														variant === "outside" ? "restricted" : "timer",
													startLine: 9,
													endLine: 9,
													pointer: null,
												},
											],
							},
						],
					});
				},
			},
		});
		const status =
			variant === "resolved"
				? "completed"
				: variant === "outside"
					? "failed"
					: "incomplete";
		expect(result.status).toBe(status);
		expect(result.review?.questions).toMatchObject([
			{
				questionId: "question-1",
				question,
				status: variant === "resolved" ? "resolved" : "unverified",
			},
		]);
		if (status === "incomplete")
			expect(result.issues).toContainEqual({
				code: "investigation_questions_unverified",
			});
		if (variant === "outside")
			expect(result.issues).toContainEqual({
				code: "invalid_model_references",
				detail: "invalid_question_check",
			});
	}
});
