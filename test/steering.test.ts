import { expect, test } from "bun:test";
import { createSteeringInbox } from "eumenes-steer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluate,
	previewScope,
	requestSchema,
	scopeSelectionSchema,
} from "../src";
import { prepareSteeredVerification } from "../src/steering";

const requestFile = "examples/cases/retry-delay.json";
const scopeFile = "examples/scopes/retry-line.json";

async function fixture() {
	const request = requestSchema.parse(await Bun.file(requestFile).json());
	const selection = scopeSelectionSchema.parse(
		await Bun.file(scopeFile).json(),
	);
	selection.evidence.required = [];
	return { request, selection };
}

const plan = { hypotheses: [], openQuestions: [], requests: [] };
const reply = (value: unknown) => ({ text: JSON.stringify(value) });

test("Steer は現在の実行に届いた許可済みの版だけを次の推論に渡す", async () => {
	const { request, selection } = await fixture();
	const source = request.evidence[0]!;
	const now = Date.now();
	let time = now;
	const inbox = createSteeringInbox({ now: () => time });
	const opened = inbox.open("run", "1");
	if (opened.status !== "opened") throw new Error(opened.status);
	const { target } = opened;
	const valid = {
		id: "valid",
		sourceRef: source.id,
		sourceRevision: source.version,
	};
	const result = await evaluate(request, {
		depth: "standard",
		selection,
		steering: target,
		model: {
			async complete(input) {
				const packet = JSON.parse(input.prompt);
				if ("evidenceCatalog" in packet) {
					expect(
						packet.evidence.map((x: { id: string }) => x.id),
					).not.toContain("timer");
					expect(inbox.enqueue("run", "2", valid).status).toBe(
						"generation_conflict",
					);
					expect(inbox.enqueue("run", "1", valid).status).toBe("accepted");
					expect(inbox.enqueue("run", "1", valid).status).toBe("duplicate");
					expect(
						inbox.enqueue("run", "1", {
							...valid,
							id: "old",
							sourceRevision: "old",
						}).status,
					).toBe("accepted");
					expect(
						inbox.enqueue("run", "1", {
							...valid,
							id: "outside",
							sourceRef: "edit:base",
						}).status,
					).toBe("accepted");
					expect(
						inbox.enqueue("run", "1", {
							...valid,
							id: "expiring",
							expiresAt: now + 1,
						}).status,
					).toBe("accepted");
					time = now + 1;
					return reply(plan);
				}
				expect(packet.steeredEvidenceIds).toEqual(["timer"]);
				expect(
					packet.evidence.filter((x: { id: string }) => x.id === "timer"),
				).toHaveLength(1);
				expect(packet.evidence.map((x: { id: string }) => x.id)).not.toContain(
					"edit:base",
				);
				expect(inbox.enqueue("run", "1", { ...valid, id: "late" }).status).toBe(
					"sealed",
				);
				return reply({
					findings: [
						{
							title: "リトライが早すぎる",
							problem: "秒の値をミリ秒として扱うタイマーへ渡している",
							trigger: "再試行待ち",
							impact: "待機時間が短くなる",
							severity: "high",
							conditionId: null,
							primary: {
								evidenceId: packet.primaryEvidenceIds[0],
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
						},
					],
					scopeChecks: packet.scope.map((evidenceId: string) => ({
						evidenceId,
						status: "checked",
						reason: null,
					})),
					conditionChecks: [],
					questionChecks: [],
				});
			},
		},
	});
	expect(result.status).toBe("completed");
	expect(result.findings[0]?.evidence[0]?.evidenceId).toBe("timer");
	expect(result.steering).toEqual({
		outcome: "committed",
		evidenceIds: ["timer"],
		ignored: 2,
	});
	expect(result.review?.stages[0]?.acquired).toEqual([]);
	expect(target.close()).toBe(1);
	expect(inbox.enqueue("run", "1", valid).status).toBe("not_open");
});

test("Steer の予算超過は未配送、応答のない推論は受理不明として確定する", async () => {
	const { request } = await fixture();
	const source = request.evidence[0]!;
	const catalog = new Map([[source.id, source]]);
	const input = { evidence: [] };
	const inbox = createSteeringInbox();
	for (const [id, limit, outcome] of [
		["budget", 100, "released"],
		["no-reply", 10000, "unknown"],
	] as const) {
		const opened = inbox.open(id, "1");
		if (opened.status !== "opened") throw new Error(opened.status);
		const { target } = opened;
		expect(
			target.enqueue({
				id: "first",
				sourceRef: source.id,
				sourceRevision: source.version,
			}).status,
		).toBe("accepted");
		const received = new Map();
		const prepared = prepareSteeredVerification(
			target,
			catalog,
			received,
			"Evaluate.",
			input,
			limit,
		);
		expect(
			prepared?.settle({ dispatched: true, responded: false }),
		).toMatchObject({ outcome });
		expect(received.has(source.id)).toBe(outcome === "unknown");
		expect(target.close()).toBe(outcome === "released" ? 1 : 0);
	}
});

test("試験用CLIは調査中に標準入力から資料を受け取り、最終判定へ渡す", async () => {
	const { request, selection } = await fixture();
	const temporary = await mkdtemp(join(tmpdir(), "eumenes-steering-test-"));
	const optionalScope = join(temporary, "scope.json");
	await Bun.write(optionalScope, JSON.stringify(selection));
	const { digest } = previewScope(request, selection);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(http) {
			const body = (await http.json()) as { messages: { content: string }[] };
			const packet = JSON.parse(body.messages[1]!.content);
			let output: unknown;
			if ("evidenceCatalog" in packet) {
				expect(
					packet.evidence.map((item: { id: string }) => item.id),
				).not.toContain("timer");
				started.resolve();
				await release.promise;
				output = plan;
			} else {
				expect(packet.steeredEvidenceIds).toEqual(["timer"]);
				expect(
					packet.evidence.filter((item: { id: string }) => item.id === "timer"),
				).toHaveLength(1);
				output = {
					findings: [],
					scopeChecks: packet.scope.map((evidenceId: string) => ({
						evidenceId,
						status: "checked",
						reason: null,
					})),
					conditionChecks: [],
					questionChecks: [],
				};
			}
			return Response.json({
				choices: [
					{
						finish_reason: "stop",
						message: { content: JSON.stringify(output) },
					},
				],
			});
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"src/cli.ts",
			requestFile,
			"--scope",
			optionalScope,
			"--expected-scope-digest",
			digest,
			"--depth",
			"standard",
			"--steer",
			"--endpoint",
			server.url.href,
			"--model",
			"fixture",
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const diagnostics = child.stderr
		.pipeThrough(new TextDecoderStream())
		.getReader();
	const output = new Response(child.stdout).text();
	try {
		await Promise.race([
			started.promise,
			child.exited.then(() => {
				throw new Error("CLI exited before investigation");
			}),
		]);
		child.stdin.write("outside\ntimer\ntimer\n");
		child.stdin.flush();
		let lines = "";
		while (!lines.includes('Steer duplicate "timer"')) {
			const chunk = await diagnostics.read();
			if (chunk.done) throw new Error("CLI exited before receiving Steer");
			lines += chunk.value;
		}
		expect(lines).toContain('Steer accepted "timer"');
		expect(lines).toContain('Steer not_allowed "outside"');
		release.resolve();
		expect(await child.exited).toBe(0);
		const result = JSON.parse(await output);
		expect(result.steering).toEqual({
			outcome: "committed",
			evidenceIds: ["timer"],
			ignored: 0,
		});
		expect(result.scopeSelection.targetDigest).toBe(selection.targetDigest);
	} finally {
		release.resolve();
		child.kill();
		server.stop(true);
		await rm(temporary, { recursive: true, force: true });
	}
}, 10000);
