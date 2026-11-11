import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	comparisonRequest,
	evaluate,
	targetDigests,
	type EvaluationModel,
	type EvaluationRequest,
	type Location,
	type ModelOutput,
	type ModelRequest,
} from "../src";
import { httpModel } from "../src/http-model";

const base = "a".repeat(40);
const head = "b".repeat(40);

function codeRequest(): EvaluationRequest {
	const target = {
		kind: "code" as const,
		id: "sample",
		version: "r2",
		base,
		head,
		changes: [
			{
				id: "change",
				path: "queue.ts",
				before: { startLine: 7, text: "const batch = 10;\n" },
				after: { startLine: 8, text: "const batch = 20;\n" },
			},
		],
	};
	return {
		contractVersion: 1,
		evaluationId: "example",
		rubric: { id: "code-correctness", version: 1 },
		target: { ...target, ...targetDigests(target) },
		scope: ["change:base", "change:head"],
		evidence: [],
		originalRequest: "処理効率を見直す",
		conditions: { state: "none" },
		limits: { timeoutMs: 2000, maxInputBytes: 12000, maxOutputTokens: 4096 },
	};
}

const location: Location = {
	evidenceId: "change:head",
	startLine: 8,
	endLine: 8,
	pointer: null,
};

function checked(...evidenceIds: string[]): ModelOutput {
	return {
		findings: [],
		scopeChecks: evidenceIds.map((evidenceId) => ({
			evidenceId,
			status: "checked",
			reason: null,
		})),
		conditionChecks: [],
	};
}

function fixed(
	output: unknown,
	onRequest?: (request: ModelRequest) => void,
): EvaluationModel {
	return {
		async complete(request) {
			onRequest?.(request);
			return {
				text: JSON.stringify(output),
				model: "test",
				usage: { inputTokens: 123 },
			};
		},
	};
}

const noCall = () => {
	let calls = 0;
	return {
		model: fixed(null, () => calls++),
		assert() {
			expect(calls).toBe(0);
		},
	};
};

function condition(
	request: EvaluationRequest,
	id: string,
	text: string,
	status = "confirmed" as const,
) {
	const { target } = request;
	return {
		id,
		text,
		status,
		appliesTo: {
			id: target.id,
			version: target.version,
			digest: target.digest,
		},
		sources: [{ id: "message-" + id, version: "1", active: true }],
	};
}

describe("固定したコード差分", () => {
	test("一回の推論で指摘ゼロの完了を返す", async () => {
		const request = codeRequest();
		let calls = 0;
		const result = await evaluate(request, {
			model: fixed(checked(...request.scope), (input) => {
				calls++;
				expect(input.maxOutputTokens).toBe(request.limits.maxOutputTokens);
				expect(input.outputSchema).toHaveProperty("properties.findings");
			}),
		});
		expect(calls).toBe(1);
		expect(result.status).toBe("completed");
		expect(result.findings).toEqual([]);
		expect(result.target?.digest).toBe(request.target.digest);
		expect(result.usage?.inputTokens).toBe(123);
	});

	test("版の違いと固定後の本文変更を推論前に拒否する", async () => {
		const request = codeRequest();
		const guard = noCall();
		request.evidence.push({
			kind: "lines",
			id: "related",
			version: base,
			side: "head",
			path: "queue.ts",
			startLine: 1,
			text: "function f() {}",
			clipped: false,
		});
		expect((await evaluate(request, guard)).issues[0]?.code).toBe(
			"evidence_version_mismatch",
		);
		if (request.target.kind !== "code") throw new Error("unexpected target");
		request.target.changes[0]!.after!.text += "const altered = true;";
		expect((await evaluate(request, guard)).issues[0]?.code).toBe(
			"target_digest_mismatch",
		);
		guard.assert();
	});

	test("足りない資料や未回答の範囲を指摘ゼロの完了と区別する", async () => {
		const request = codeRequest();
		request.scope.push("missing", "truncated");
		request.evidence.push({
			kind: "lines",
			id: "truncated",
			version: head,
			side: "head",
			path: "queue.ts",
			startLine: 1,
			text: "function f() {}",
			clipped: true,
		});
		const result = await evaluate(request, {
			model: fixed(checked("change:head", "truncated")),
		});
		expect(result.status).toBe("incomplete");
		expect(result.scopeChecks.map((item) => item.status)).toEqual([
			"unverified",
			"checked",
			"unverified",
			"unverified",
		]);
	});

	test("対象範囲、条件状態、入力サイズの不足を報告する", async () => {
		const request = codeRequest();
		const guard = noCall();
		request.scope = ["missing"];
		expect((await evaluate(request, guard)).issues[0]?.code).toBe(
			"target_scope_missing",
		);
		request.scope = ["change:head"];
		request.limits.maxInputBytes = 8;
		expect((await evaluate(request, guard)).issues[0]?.code).toBe(
			"prompt_size_limit",
		);
		guard.assert();
		request.limits.maxInputBytes = 12000;
		request.conditions = { state: "unavailable", reason: "出所を取得できない" };
		const result = await evaluate(request, {
			model: fixed(checked(...request.scope)),
		});
		expect(result.status).toBe("incomplete");
		expect(result.issues[0]?.code).toBe("conditions_unavailable");
	});

	test("有効な確定条件だけを推論に渡し、条件違反の根拠を返す", async () => {
		const request = codeRequest();
		request.conditions = {
			state: "available",
			revision: "s4",
			entries: [
				{ ...condition(request, "old", "古い条件"), status: "superseded" },
				{ ...condition(request, "removed", "撤回条件"), status: "withdrawn" },
				{ ...condition(request, "draft", "提案中"), status: "proposed" },
				{
					...condition(request, "other", "対象外"),
					appliesTo: {
						id: "other",
						version: "r2",
						digest: request.target.digest,
					},
				},
				{
					...condition(request, "other-version", "旧版"),
					appliesTo: {
						id: request.target.id,
						version: "r1",
						digest: request.target.digest,
					},
				},
				condition(request, "current", "バッチ上限は 10"),
			],
		};
		const output: ModelOutput = {
			...checked(...request.scope),
			findings: [
				{
					title: "バッチ上限を超える",
					problem: "上限が 10 のところ 20 を設定しています",
					trigger: "バッチ処理の実行時",
					impact: "1回の処理件数が合意範囲を超えます",
					severity: "medium",
					conditionId: "current",
					primary: location,
					evidence: [],
				},
			],
			conditionChecks: [
				{
					conditionId: "current",
					status: "violated",
					reason: "設定値は 20",
					evidence: [location],
				},
			],
		};
		const result = await evaluate(request, {
			model: fixed(output, ({ prompt }) => {
				expect(JSON.parse(prompt).conditions).toEqual([
					{
						id: "current",
						text: "バッチ上限は 10",
						sources: [{ id: "message-current", version: "1" }],
					},
				]);
			}),
		});
		expect(result.status).toBe("completed");
		expect(result.conditionRevision).toBe("s4");
		expect(result.findings).toEqual(output.findings);
	});

	test("失効した出所と確認結果がない条件を未確認として扱う", async () => {
		const request = codeRequest();
		const inactive = condition(request, "inactive", "失効済み");
		inactive.sources[0]!.active = false;
		request.conditions = {
			state: "available",
			revision: "s5",
			entries: [inactive, condition(request, "current", "現在の条件")],
		};
		const result = await evaluate(request, {
			model: fixed(checked(...request.scope), ({ prompt }) => {
				expect(
					JSON.parse(prompt).conditions.map((item: { id: string }) => item.id),
				).toEqual(["current"]);
			}),
		});
		expect(result.status).toBe("incomplete");
		expect(result.issues.map((issue) => issue.code)).toEqual([
			"condition_sources_inactive",
			"conditions_unverified",
		]);
		expect(result.conditionChecks[0]).toMatchObject({
			conditionId: "current",
			status: "unverified",
		});
	});

	test("比較の対象と予算を保ち、条件または元の依頼を個別に渡す", () => {
		const request = codeRequest();
		request.conditions = {
			state: "available",
			revision: "r1",
			entries: [condition(request, "limit", "上限")],
		};
		const a = comparisonRequest(request, "A");
		const b = comparisonRequest(request, "B");
		const c = comparisonRequest(request, "C");
		const d = comparisonRequest(request, "D");
		expect(a.rubric.id).toBe("code-general");
		expect(b.rubric).toEqual(c.rubric);
		expect(b.rubric).toEqual(d.rubric);
		expect(a.conditions.state).toBe("none");
		expect(b.conditions.state).toBe("none");
		expect(c.conditions.state).toBe("available");
		expect(d.conditions.state).toBe("none");
		expect(c.originalRequest).toBeUndefined();
		expect(d.originalRequest).toBe(request.originalRequest);
		for (const arm of [a, b, c, d]) {
			expect(arm.target).toEqual(request.target);
			expect(arm.limits).toEqual(request.limits);
		}
	});
});

describe("出力の照合と実行制限", () => {
	test("存在しない根拠、異なる側の行、抜粋範囲外を拒否する", async () => {
		const request = codeRequest();
		for (const primary of [
			{ ...location, evidenceId: "missing" },
			{ ...location, evidenceId: "change:base" },
			{ ...location, endLine: 9 },
		]) {
			const output: ModelOutput = {
				...checked(...request.scope),
				findings: [
					{
						title: "指摘",
						problem: "問題",
						trigger: "条件",
						impact: "影響",
						severity: "medium",
						primary,
						evidence: [],
						conditionId: null,
					},
				],
			};
			const result = await evaluate(request, { model: fixed(output) });
			expect(result.status).toBe("failed");
			expect(result.issues[0]?.code).toBe("invalid_model_references");
			expect(result.findings).toEqual([]);
		}
	});

	test("JSON 解析失敗、スキーマ違反、根拠がない適合判定を拒否する", async () => {
		const request = codeRequest();
		const malformed = await evaluate(request, {
			model: {
				async complete() {
					return { text: "bad json" };
				},
			},
		});
		expect(malformed.issues[0]?.code).toBe("invalid_model_output");
		expect(
			(await evaluate(request, { model: fixed({ findings: [] }) })).issues[0]
				?.code,
		).toBe("invalid_model_output");
		request.conditions = {
			state: "available",
			revision: "r1",
			entries: [condition(request, "limit", "上限")],
		};
		const output = {
			...checked(...request.scope),
			conditionChecks: [
				{
					conditionId: "limit",
					status: "satisfied",
					reason: "適合",
					evidence: [],
				},
			],
		};
		expect(
			(await evaluate(request, { model: fixed(output) })).issues[0]?.code,
		).toBe("invalid_model_references");
	});

	test("期限超過と取消はモデルが応答しなくても終了する", async () => {
		const request = codeRequest();
		let signal: AbortSignal | undefined;
		const model: EvaluationModel = {
			async complete(_request, received) {
				signal = received;
				return new Promise(() => {});
			},
		};
		request.limits.timeoutMs = 30;
		expect((await evaluate(request, { model })).status).toBe("expired");
		expect(signal?.aborted).toBe(true);
		request.limits.timeoutMs = 2000;
		const controller = new AbortController();
		const pending = evaluate(request, { model, signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		expect((await pending).status).toBe("cancelled");
		expect(signal?.aborted).toBe(true);
	});
});

test("Workflow の JSON Pointer を使って確定条件を照合する", async () => {
	const request = codeRequest();
	const target = {
		kind: "workflow" as const,
		id: "workflow",
		version: "w2",
		document: { "release/scope": ["public"] },
	};
	request.target = { ...target, ...targetDigests(target) };
	request.rubric.id = "workflow-correctness";
	request.scope = ["workflow"];
	request.conditions = {
		state: "available",
		revision: "r1",
		entries: [condition(request, "scope", "チーム内に公開する")],
	};
	const primary = {
		evidenceId: "workflow",
		startLine: null,
		endLine: null,
		pointer: "/release~1scope/0",
	};
	const output: ModelOutput = {
		...checked("workflow"),
		findings: [
			{
				title: "公開先をチーム内に限定する",
				problem: "公開範囲に public が設定されています",
				trigger: "ワークフローの公開時",
				impact: "チーム外に成果物が公開されます",
				severity: "high",
				conditionId: "scope",
				primary,
				evidence: [],
			},
		],
		conditionChecks: [
			{
				conditionId: "scope",
				status: "violated",
				reason: "公開範囲が public",
				evidence: [primary],
			},
		],
	};
	const result = await evaluate(request, { model: fixed(output) });
	expect(result.status).toBe("completed");
	expect(result.findings[0]?.primary.pointer).toBe("/release~1scope/0");
	for (const pointer of [
		"/release~1scope/01",
		"/release~2scope/0",
		"/toString",
	]) {
		output.conditionChecks[0]!.evidence[0]!.pointer = pointer;
		expect(
			(await evaluate(request, { model: fixed(output) })).issues[0]?.code,
		).toBe("invalid_model_references");
	}
});

test("CLI は標準入力の評価依頼と固定応答から結果 JSON を返す", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"src/cli.ts",
			"-",
			"--fixture",
			"examples/code-response.json",
			"--arm",
			"C",
		],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			stdin: Bun.file(
				new URL("../examples/code-request.json", import.meta.url),
			),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({
		status: "completed",
		arm: "C",
		conditionChecks: [{ conditionId: "max-batch-size", status: "violated" }],
	});
});

test("HTTP アダプターは一回の構造化推論で利用量を取得する", async () => {
	const request = codeRequest();
	let calls = 0;
	let payload: Record<string, unknown> | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls++;
			payload = (await request.json()) as Record<string, unknown>;
			return Response.json({
				model: "local-model",
				choices: [
					{
						finish_reason: "stop",
						message: {
							content: JSON.stringify(checked("change:base", "change:head")),
						},
					},
				],
				usage: { prompt_tokens: 21, completion_tokens: 30 },
			});
		},
	});
	try {
		const result = await evaluate(request, {
			model: httpModel(
				new URL("v1/chat/completions", server.url).href,
				"fixture",
			),
		});
		expect(calls).toBe(1);
		expect(payload).toMatchObject({
			model: "fixture",
			stream: false,
			max_tokens: 4096,
			response_format: { type: "json_schema", json_schema: { strict: true } },
		});
		expect(payload).not.toHaveProperty("tools");
		expect(result).toMatchObject({
			status: "completed",
			model: "local-model",
			usage: { inputTokens: 21, outputTokens: 30 },
		});
	} finally {
		server.stop(true);
	}
});
