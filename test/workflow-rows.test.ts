import { expect, test } from "bun:test";
import {
	evaluate,
	previewScope,
	targetDigests,
	type ModelRequest,
	type ScopeSelection,
} from "../src";

const document = {
	asOf: "12:00",
	confirmedApprovals: { "P-02": { audience: "NO_RECORD" } },
	records: {
		"P-04": { embargo: "12:30", waiver: { id: "w41", end: "12:00" } },
		"P-05": {
			approval: { id: "e52", status: "GRANT" },
			revoke: { id: "e53", received: "12:03" },
		},
		"P-06": { dependencies: ["P-05", "P-04"] },
		"P-07": { dependencies: ["P-06"] },
	},
	decisions: [
		{ id: "P-02", current: "SCOPE" },
		{ id: "P-04", current: "READY" },
		{ id: "P-05", current: "SCOPE" },
		{ id: "P-06", current: "DEP" },
		{ id: "P-07", current: "EMBARGO" },
	],
};
const snapshot = {
	kind: "workflow",
	id: "release",
	version: "1",
	document,
} as const;
const target = { ...snapshot, ...targetDigests(snapshot) };
const conditionId = "release-policy";
const request = {
	contractVersion: 1,
	evaluationId: "workflow-rows",
	target,
	rubric: { id: "workflow-correctness", version: 1 },
	originalRequest: "期待判定と現行コードを照合し、引継ぎ表に根拠IDを記載する。",
	scope: ["workflow"],
	evidence: [],
	conditions: {
		state: "available",
		revision: "1",
		entries: [
			{
				id: conditionId,
				text: "対象承認がなければSCOPE。免除は終了時刻未満のみ有効。基準時刻後に受領した取消は適用しない。依存先の判定を求め、指定順で最初の非READYから停止連鎖を示す。",
				status: "confirmed",
				appliesTo: {
					id: target.id,
					version: target.version,
					digest: target.digest,
				},
				sources: [{ id: "confirmed", version: "1", active: true }],
			},
		],
	},
	limits: { timeoutMs: 1000, maxInputBytes: 65536, maxOutputTokens: 2000 },
};
const selection: ScopeSelection = {
	version: 1,
	targetId: target.id,
	targetVersion: target.version,
	targetDigest: target.digest,
	include: document.decisions.map((_, i) => ({
		kind: "pointer",
		pointer: "/decisions/" + i,
	})),
	conditionIds: [conditionId],
	evidence: { initial: ["workflow"] },
};
const comparison = {
	...selection,
	currentValuePointer: "/current",
	rowLabelPointer: "/id",
};

const refs = (...pointers: string[]) =>
	pointers.map((pointer) => ({ evidenceId: "workflow", pointer }));
function row(
	index: number,
	expected: string | null,
	reason: string,
	...pointers: string[]
) {
	return {
		pointer: "/decisions/" + index + "/current",
		basis: {
			facts: reason,
			value: expected,
			via: null as { row: string; value: string } | null,
		},
		conditionId,
		evidence: refs(...pointers),
	};
}
const rows = [
	row(
		0,
		"SCOPE",
		"対象承認なし。成果物の根拠IDは -。",
		"/confirmedApprovals/P-02",
	),
	row(1, "EMBARGO", "w41 は基準時刻ちょうどに失効。", "/asOf", "/records/P-04"),
	row(
		2,
		"READY",
		"e53 は締切後受領のため e52 が有効。",
		"/asOf",
		"/records/P-05",
	),
	row(
		3,
		"DEP",
		"P-04 で停止。現行に根拠ID欄はない。",
		"/records/P-06",
		"/records/P-04",
		"/records/P-05",
	),
	row(
		4,
		"DEP",
		"P-05 は通過し、P-04 は解禁前。停止連鎖は P-06>P-04。",
		"/records/P-07",
		"/records/P-06",
		"/records/P-04",
		"/records/P-05",
		"/asOf",
	),
];
rows[3]!.basis.via = { row: rows[1]!.pointer, value: "EMBARGO" };
rows[4]!.basis.via = { row: rows[3]!.pointer, value: "DEP" };
const conditions = [
	{
		conditionId,
		verified: true,
		reason: "基準時刻の判定を照合",
		evidence: refs("/asOf"),
	},
];

function model(output: unknown, inspect?: (packet: ModelRequest) => void) {
	return {
		async complete(packet: ModelRequest) {
			inspect?.(packet);
			return { text: JSON.stringify(output), model: "fixture" };
		},
	};
}

test("現行と期待が同じ行の指摘を抑え、複数の根拠に基づく差と連鎖を返す", async () => {
	const preview = previewScope(request, selection);
	const legacy = await evaluate(request, {
		selection,
		model: model({
			scopeChecks: preview.selected.map(({ id }) => ({
				evidenceId: id,
				status: "checked",
				reason: null,
			})),
			conditionChecks: [
				{
					conditionId,
					status: "violated",
					reason: "根拠IDが現行にない",
					evidence: [
						{
							evidenceId: "workflow",
							pointer: "/asOf",
							startLine: null,
							endLine: null,
						},
					],
				},
			],
			findings: (
				[
					[0, "対象承認がなく SCOPE が正しい"],
					[3, "DEP は一致するが現行に根拠IDがない"],
					[4, "DEP の根拠は P-05>P-06"],
				] as const
			).map(([index, problem]) => ({
				title: "要修正",
				problem,
				trigger: "基準時刻",
				impact: "引継ぎ",
				severity: "medium",
				conditionId,
				evidence: [],
				primary: {
					evidenceId: preview.selected[index]!.id,
					pointer: "/decisions/" + index,
					startLine: null,
					endLine: null,
				},
			})),
		}),
	});
	expect(legacy.status).toBe("completed");
	expect(legacy.findings.map(({ primary }) => primary.pointer)).toEqual([
		"/decisions/0",
		"/decisions/3",
		"/decisions/4",
	]);
	expect(legacy.findings[2]?.problem).toContain("P-05>P-06");
	const revised = await evaluate(request, {
		selection: comparison,
		model: model({ rows, conditions }, ({ system, prompt, outputSchema }) => {
			const packet = JSON.parse(prompt);
			expect(packet.currentValuePointer).toBe("/current");
			expect(packet.comparisonPointers).toEqual(
				rows.map(({ pointer }) => pointer),
			);
			expect(
				packet.evidence.find(({ id }: { id: string }) => id === "workflow")
					.document,
			).toEqual(document);
			expect(packet.scope).toEqual(packet.primaryEvidenceIds);
			expect(system).toContain("関連資料を横断して期待値を求めて");
			expect(outputSchema.required).toEqual(["rows", "conditions"]);
		}),
	});
	expect(revised.status).toBe("completed");
	expect(revised.findings.map(({ primary }) => primary.pointer)).toEqual([
		"/decisions/1/current",
		"/decisions/2/current",
		"/decisions/4/current",
	]);
	expect(revised.findings[2]?.problem).toContain("P-06>P-04");
	expect(revised.findings[2]?.evidence.map(({ pointer }) => pointer)).toContain(
		"/records/P-04",
	);
	expect(revised.conditionChecks[0]?.evidence).toEqual(
		revised.findings.map(({ primary }) => primary),
	);
});

test("許可した個別台帳を資料IDだけで引用し、重複した行は未確認にする", async () => {
	const ledger = {
		id: "ledger",
		kind: "json",
		version: target.version,
		clipped: false,
		document: document.records,
	};
	const oneRow = {
		...comparison,
		include: [{ kind: "pointer", pointer: "/decisions/4" }] as const,
		evidence: { initial: [ledger.id] },
	};
	const ledgerRef = [{ evidenceId: ledger.id, pointer: null }];
	const rowWithLedger = {
		...rows[4],
		basis: { ...rows[4]!.basis, via: null },
		evidence: ledgerRef,
	};
	const conditionWithLedger = { ...conditions[0], evidence: ledgerRef };
	const result = await evaluate(
		{ ...request, evidence: [ledger] },
		{
			selection: oneRow,
			model: model({
				rows: [rowWithLedger],
				conditions: [conditionWithLedger],
			}),
		},
	);
	expect(result.status).toBe("completed");
	expect(result.findings[0]?.evidence[0]).toMatchObject({
		evidenceId: ledger.id,
		pointer: "",
	});
	const duplicate = await evaluate(
		{ ...request, evidence: [ledger] },
		{
			selection: oneRow,
			model: model({
				rows: [rowWithLedger, rowWithLedger],
				conditions: [conditionWithLedger],
			}),
		},
	);
	expect(duplicate.status).toBe("incomplete");
	expect(duplicate.scopeChecks[0]).toMatchObject({
		status: "unverified",
		reason: "同じ行の判定が複数返りました",
	});
	expect(duplicate.findings).toEqual([]);
});

test("根拠から求めた判定値を一つだけ受け取り、二重の判定欄があれば拒む", async () => {
	const answer = rows.map((row, index) =>
		index === 1 ? { ...row, expected: "READY" } : row,
	);
	const invalid = await evaluate(request, {
		selection: comparison,
		model: model({ rows: answer, conditions }),
	});
	expect(invalid.status).toBe("failed");
	expect(invalid.issues).toEqual([{ code: "invalid_model_output" }]);
	expect(invalid.findings).toEqual([]);
	const valid = await evaluate(request, {
		selection: comparison,
		model: model({ rows, conditions }),
	});
	expect(valid.status).toBe("completed");
	expect(
		valid.findings.find(({ primary }) => primary.pointer === rows[1]!.pointer)
			?.problem,
	).toContain("期待値: EMBARGO");
});

test("直接の依存先をたどり、転記された連鎖を使わず、循環と判定の不一致を拒む", async () => {
	const answer = structuredClone(rows);
	answer[4]!.basis.facts = "誤った連鎖 P-05>P-06";
	const run = () =>
		evaluate(request, {
			selection: comparison,
			model: model({ rows: answer, conditions }),
		});
	const valid = await run();
	const finding = valid.findings.find(
		({ primary }) => primary.pointer === "/decisions/4/current",
	);
	expect(valid.status).toBe("completed");
	expect(finding?.problem).toContain("P-06>P-04");
	expect(finding?.problem).not.toContain("P-05>P-06");

	for (const via of [
		{ row: rows[2]!.pointer, value: "SCOPE" },
		{ row: rows[4]!.pointer, value: "DEP" },
		{ row: "/decisions/9/current", value: "DEP" },
	]) {
		answer[3]!.basis.via = via;
		const invalid = await run();
		expect(invalid.status).toBe("incomplete");
		expect(invalid.scopeChecks.slice(3).map(({ status }) => status)).toEqual([
			"unverified",
			"unverified",
		]);
		expect(
			invalid.findings.some(
				({ primary }) => primary.pointer === "/decisions/4/current",
			),
		).toBe(false);
	}
});

test("判定コードの一覧を構造化出力に渡し、コードに混ざった根拠IDを拒む", async () => {
	const expectedValues = ["SCOPE", "EMBARGO", "READY", "DEP"];
	const answer = structuredClone(rows);
	answer[3]!.basis.value = "DEP:P-04";
	const result = await evaluate(request, {
		selection: { ...comparison, expectedValues },
		model: model({ rows: answer, conditions }, ({ outputSchema }) => {
			const schema = JSON.stringify(outputSchema);
			expect(schema).toContain(JSON.stringify(expectedValues));
		}),
	});
	expect(result.status).toBe("incomplete");
	expect(result.scopeChecks[3]).toMatchObject({
		status: "unverified",
		reason: "期待値が指定された判定値の一覧にありません",
	});
	expect(result.scopeChecks[4]?.status).toBe("unverified");
	expect(result.findings.map(({ primary }) => primary.pointer)).toEqual([
		"/decisions/1/current",
		"/decisions/2/current",
	]);
});

test("資料不足、参照違反、未回答をそれぞれ未完了にする", async () => {
	for (const [answer, reason] of [
		[
			[...rows.slice(0, 4), row(4, null, "依存先の台帳が未提供")],
			"依存先の台帳が未提供",
		],
		[rows, "期待値を裏付ける根拠位置を確認できませんでした"],
		[rows.slice(0, 4), "モデルから有効な確認結果が返りませんでした"],
	] as const) {
		const result = await evaluate(request, {
			selection:
				answer === rows
					? { ...comparison, evidence: { initial: [] } }
					: comparison,
			model: model({ rows: answer, conditions }),
		});
		expect(result.status).toBe("incomplete");
		expect(result.issues).toContainEqual({ code: "scope_unverified" });
		expect(result.scopeChecks[4]).toMatchObject({
			status: "unverified",
			reason,
		});
		expect(
			result.findings.some(
				({ primary }) => primary.pointer === "/decisions/4/current",
			),
		).toBe(false);
	}
});
