import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	httpModel,
	openaiEndpoint,
	openaiLuna,
	openaiLunaModel,
} from "../http-model";
import { fingerprint } from "../snapshot";
import { loadScorableRun } from "./archive";
import { score } from "./report";
import { runSuite } from "./run";
import { loadSuite, readJson, schedule, withCodexSdk } from "./suite";

const help = [
	"bun run bench check [--suite examples/suite.json]",
	"bun run bench run (--openai | --endpoint <chat-completions-url> --model <model>) [--repeat 3] [--case <id>] [--out <new-directory>] [--suite <file>]",
	"bun run bench run --openai --codex-sdk --repeat 3 [--suite examples/multi-evidence-suite.json]",
	"bun run bench run --openai --codex-sdk-low --repeat 3 [--suite examples/multi-evidence-suite.json]",
	"bun run bench score <run-directory> <scores.json>",
].join("\n");

async function main() {
	const { positionals, values } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			openai: { type: "boolean" },
			"codex-sdk": { type: "boolean" },
			"codex-sdk-low": { type: "boolean" },
			endpoint: { type: "string" },
			model: { type: "string" },
			suite: { type: "string" },
			repeat: { type: "string" },
			case: { type: "string", multiple: true },
			out: { type: "string" },
		},
	});
	if (values.help) {
		console.log(help);
		return;
	}
	const [command, ...args] = positionals;
	if (
		command === "score" &&
		args.length === 2 &&
		Object.keys(values).length === 0
	) {
		const [directory, grades] = args as [string, string];
		const maxBytes = 64 * 1024 * 1024;
		const [{ cases, trials }, scores] = await Promise.all([
			loadScorableRun(directory),
			readJson(grades, maxBytes),
		]);
		console.log(JSON.stringify(score(trials, cases, scores), null, "\t"));
		return;
	}
	if (args.length || (command !== "check" && command !== "run"))
		throw new Error(help);
	if (command === "check" && Object.keys(values).some((key) => key !== "suite"))
		throw new Error(help);
	if (
		command === "run" &&
		(values.openai
			? values.endpoint !== undefined || values.model !== undefined
			: !values.endpoint || !values.model)
	)
		throw new Error(help);
	const sdkLow = values["codex-sdk-low"];
	const useSdk = sdkLow || values["codex-sdk"];
	if ((useSdk && !values.openai) || (sdkLow && values["codex-sdk"]))
		throw new Error(
			"SDK 比較は --openai と組み合わせ、SDK の比較方式を一つ指定してください",
		);
	const cases = await loadSuite(
		values.suite ??
			(useSdk ? "examples/multi-evidence-suite.json" : "examples/suite.json"),
	);
	if (command === "check") {
		console.log(
			JSON.stringify(
				{
					cases: cases.map((item) => ({ id: item.id, group: item.group })),
					trials: schedule(cases, 1).length,
				},
				null,
				"\t",
			),
		);
		return;
	}

	const selected = new Set(values.case);
	const subset = selected.size
		? cases.filter((item) => selected.has(item.id))
		: cases;
	if (selected.size && subset.length !== selected.size)
		throw new Error("スイートにないケース ID が指定されています");
	const repeats = Number(values.repeat ?? "1");
	if (!Number.isSafeInteger(repeats) || repeats < 1)
		throw new Error("--repeat に正の整数を指定してください");
	const modelId = values.openai ? openaiLuna : values.model!;
	const endpoint = values.openai ? openaiEndpoint : values.endpoint!;
	let codexSdk: Parameters<typeof runSuite>[1]["codexSdk"];
	if (useSdk) {
		const { bareReviewRequest, codexSdkLunaModel } =
			await import("./codex-sdk");
		const reasoningEffort = sdkLow ? "low" : undefined;
		codexSdk = {
			...codexSdkLunaModel({ reasoningEffort }),
			...(reasoningEffort
				? {
						bare: {
							model: codexSdkLunaModel({ reasoningEffort, bare: true }).model,
							reasoningEffort,
							promptDigest: fingerprint(bareReviewRequest),
						},
					}
				: {}),
		};
	}
	const model = codexSdk?.bare
		? codexSdk.model
		: values.openai
			? openaiLunaModel()
			: httpModel(endpoint, modelId, Bun.env.EVALUATOR_API_KEY);
	const directory = resolve(
		values.out ??
			join(
				"verification-runs",
				new Date().toISOString().replaceAll(":", "-") +
					"-" +
					crypto.randomUUID().slice(0, 8),
			),
	);
	const controller = new AbortController();
	const abort = () => controller.abort();
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	try {
		const result = await runSuite(
			codexSdk ? withCodexSdk(subset, sdkLow ? "sdk-low" : "mixed") : subset,
			{
				model,
				codexSdk,
				modelId,
				endpointHost: new URL(endpoint).hostname,
				repeats,
				output: directory,
				signal: controller.signal,
				progress: (trial) =>
					console.error(
						`${trial.caseId} ${trial.arm} #${trial.repeat}: ${trial.result.status}` +
							(trial.mismatches.length
								? ` (期待値との差 ${trial.mismatches.length}件)`
								: ""),
					),
			},
		);
		console.log(JSON.stringify({ directory, ...result }, null, "\t"));
		process.exitCode = result.interrupted ? 1 : result.mismatched ? 2 : 0;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "検証を実行できませんでした",
	);
	process.exitCode = 1;
});
