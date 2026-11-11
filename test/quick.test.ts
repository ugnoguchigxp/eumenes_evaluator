import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	changeEvidenceId,
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
import { readText } from "../src/read-text";

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

test("循環する JSON 資料をモデルを呼ばずに拒否する", async () => {
	const request = codeRequest();
	const document: Record<string, unknown> = {};
	document.child = document;
	const input = {
		...request,
		evidence: [
			{
				kind: "json",
				id: "supplement",
				version: request.target.version,
				clipped: false,
				document,
			},
		],
	};
	const { model, assert } = noCall();
	const result = await evaluate(input, { model });
	expect(result.status).toBe("failed");
	expect(result.issues[0]?.code).toBe("invalid_request");
	assert();
});

test("長い変更 ID も位置を引用でき、既存の短い ID は維持する", async () => {
	const request = codeRequest();
	if (request.target.kind !== "code") throw new Error("code required");
	const change = request.target.changes[0]!;
	change.id = "x".repeat(256);
	Object.assign(request.target, targetDigests(request.target));
	expect(changeEvidenceId("change", "head")).toBe("change:head");
	const evidenceId = changeEvidenceId(change.id, "head");
	request.scope = [evidenceId];
	const result = await evaluate(request, {
		model: fixed(checked(evidenceId), ({ prompt }) => {
			expect(JSON.parse(prompt).evidence[1].id).toBe(evidenceId);
		}),
	});
	expect(result.status).toBe("completed");
});

test("返却できる最大行番号を超える抜粋を推論前に拒否する", async () => {
	const request = codeRequest();
	if (request.target.kind !== "code") throw new Error("code required");
	request.target.changes[0]!.after = {
		startLine: 10_000_000,
		text: "last\nextra\n",
	};
	Object.assign(request.target, targetDigests(request.target));
	const { model, assert } = noCall();
	const result = await evaluate(request, { model });
	expect(result.issues[0]?.code).toBe("invalid_request");
	assert();
});

test("サイズ上限のエラーは入力ストリームのキャンセル完了を待たない", async () => {
	const cleanup = Promise.withResolvers<void>();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(2));
		},
		cancel() {
			cancelled = true;
			return cleanup.promise;
		},
	});
	try {
		await expect(readText(stream, 1)).rejects.toThrow("サイズ上限");
		expect(cancelled).toBe(true);
		expect(stream.locked).toBe(false);
	} finally {
		cleanup.resolve();
	}
}, 1000);

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
		expect(result.status).toBe("incomplete");
		expect(result.issues).toEqual([
			{ code: "condition_target_mismatch", detail: "other" },
			{ code: "condition_target_mismatch", detail: "other-version" },
		]);
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
			expect(result.status).toBe("incomplete");
			expect(result.issues[0]?.code).toBe("model_output_partially_rejected");
			expect(result.rejected).toHaveLength(1);
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
		).toBe("model_output_partially_rejected");
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
		).toBe("model_output_partially_rejected");
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

test("適用版違いの確定条件を報告し、訂正・撤回は記録だけに残す", async () => {
	const request = codeRequest();
	const stale = condition(request, "stale", "旧版の条件");
	stale.appliesTo.version = "r1";
	const withdrawn = {
		...condition(request, "withdrawn", "撤回済み"),
		status: "withdrawn" as const,
	};
	const superseded = {
		...condition(request, "superseded", "訂正済み"),
		status: "superseded" as const,
	};
	request.conditions = {
		state: "available",
		revision: "r2",
		entries: [stale, withdrawn, superseded],
	};
	const model = fixed(checked(...request.scope), ({ prompt }) => {
		expect(JSON.parse(prompt).conditions).toEqual([]);
	});
	const result = await evaluate(request, { model });
	expect(result.status).toBe("incomplete");
	expect(result.issues).toEqual([
		{ code: "condition_target_mismatch", detail: "stale" },
	]);
	expect(result.conditionSelection).toEqual({
		applied: [],
		excluded: [
			{ id: "stale", reason: "target_mismatch" },
			{ id: "withdrawn", reason: "not_confirmed" },
			{ id: "superseded", reason: "not_confirmed" },
		],
	});
	request.conditions.entries.shift();
	const corrected = await evaluate(request, { model });
	expect(corrected.status).toBe("completed");
	expect(corrected.conditionSelection.excluded).toHaveLength(2);
});

test("不正な根拠の指摘だけ除外して正しい指摘を残す", async () => {
	const request = codeRequest();
	const good = {
		title: "指摘",
		problem: "バッチ上限を超える",
		trigger: "処理時",
		impact: "処理失敗",
		severity: "medium" as const,
		primary: location,
		evidence: [],
		conditionId: null,
	};
	const result = await evaluate(request, {
		model: fixed({
			...checked(...request.scope),
			findings: [
				good,
				{ ...good, evidence: [{ ...location, startLine: 9, endLine: 9 }] },
			],
		}),
	});
	expect(result.status).toBe("incomplete");
	expect(result.findings).toEqual([good]);
	expect(result.rejected).toEqual([
		{ kind: "findings", index: 1, reason: "finding_location_unavailable" },
	]);
});

test("確認結果の重複・未知IDと条件違反の矛盾を項目単位で扱う", async () => {
	const request = codeRequest();
	request.conditions = {
		state: "available",
		revision: "r1",
		entries: [
			"valid",
			"missing-finding",
			"conflict",
			"no-evidence",
			"duplicate",
			"bad-reference",
		].map((id) => condition(request, id, "条件")),
	};
	const good = {
		title: "指摘",
		problem: "条件違反",
		trigger: "処理時",
		impact: "処理失敗",
		severity: "medium" as const,
		primary: location,
		evidence: [],
		conditionId: "valid",
	};
	const check = (
		conditionId: string,
		status: "satisfied" | "violated",
		evidence = [location],
	) => ({ conditionId, status, evidence, reason: "判定" });
	const complete = checked(...request.scope);
	const result = await evaluate(request, {
		model: fixed({
			findings: [
				good,
				{ ...good, conditionId: "conflict" },
				{ ...good, conditionId: "no-evidence" },
				{ ...good, conditionId: "unknown" },
				{ ...good, conditionId: "bad-reference" },
			],
			scopeChecks: [
				...complete.scopeChecks,
				complete.scopeChecks[0],
				{ evidenceId: request.scope[1], status: "unverified", reason: "不明" },
				{ evidenceId: "unknown", status: "checked", reason: null },
			],
			conditionChecks: [
				check("valid", "violated"),
				check("valid", "violated"),
				check("missing-finding", "violated"),
				check("conflict", "satisfied"),
				check("no-evidence", "violated", []),
				check("duplicate", "satisfied"),
				check("duplicate", "violated"),
				check("unknown", "satisfied"),
				check("bad-reference", "violated", [{ ...location, endLine: 9 }]),
			],
		}),
	});
	expect(result.status).toBe("incomplete");
	expect(result.findings).toEqual([good]);
	expect(result.scopeChecks.map((check) => check.status)).toEqual([
		"checked",
		"unverified",
	]);
	expect(result.conditionChecks.map((check) => check.status)).toEqual([
		"violated",
		"unverified",
		"unverified",
		"unverified",
		"unverified",
		"unverified",
	]);
	expect(
		result.rejected.map(({ kind, index }) => `${kind}:${index}`).sort(),
	).toEqual(
		[
			"scopeChecks:1",
			"scopeChecks:3",
			"scopeChecks:4",
			"conditionChecks:2",
			"conditionChecks:3",
			"conditionChecks:4",
			"conditionChecks:5",
			"conditionChecks:6",
			"conditionChecks:7",
			"conditionChecks:8",
			"findings:1",
			"findings:2",
			"findings:3",
			"findings:4",
		].sort(),
	);
});

test("HTTP の認証・制限・障害・切断・拒否・不正応答を区別する", async () => {
	const cases = [
		[() => new Response("private", { status: 401 }), "auth"],
		[() => new Response("private", { status: 429 }), "rate_limited"],
		[() => new Response("private", { status: 503 }), "unavailable"],
		[
			() =>
				Response.json({
					choices: [
						{ finish_reason: "length", message: { content: "private" } },
					],
				}),
			"truncated",
		],
		[
			() =>
				Response.json({
					choices: [
						{ finish_reason: "content_filter", message: { content: null } },
					],
				}),
			"refused",
		],
		[() => new Response("private"), "invalid_response"],
	] as const;
	const originalFetch = globalThis.fetch;
	try {
		for (const [reply, detail] of cases) {
			globalThis.fetch = Object.assign(async () => reply(), {
				preconnect: originalFetch.preconnect,
			});
			const result = await evaluate(codeRequest(), {
				model: httpModel("http://127.0.0.1/", "fixture", "private"),
			});
			expect(result.status).toBe("failed");
			expect(result.issues).toEqual([{ code: "model_request_failed", detail }]);
			expect(JSON.stringify(result)).not.toContain("private");
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
	expect(() => httpModel("file:///tmp/test", "fixture")).toThrow();
	expect(() =>
		httpModel("https://user:pass@host.invalid/", "fixture"),
	).toThrow();
	expect(() =>
		httpModel("http://host.invalid/", "fixture", "private"),
	).toThrow();
	expect(() =>
		httpModel("http://127.0.0.1/", "fixture", "private"),
	).not.toThrow();
});

test("入力を検証している間に期限が尽きたときは推論を開始しない", async () => {
	const request = codeRequest();
	const time = spyOn(performance, "now").mockReturnValue(3_000);
	time.mockReturnValueOnce(0);
	const calls = noCall();
	try {
		const result = await evaluate(request, { model: calls.model });
		expect(result.status).toBe("expired");
		expect(result.issues).toEqual([{ code: "deadline_exceeded" }]);
		calls.assert();
	} finally {
		time.mockRestore();
	}
});
