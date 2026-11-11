import { parseArgs } from "node:util";
import { openSteeringConsole } from "./bench/steering-console";
import {
	MAX_INPUT_BYTES,
	MAX_RESPONSE_BYTES,
	requestSchema,
	type EvaluationModel,
} from "./contracts";
import { evaluate, previewScope } from "./evaluate";
import { httpModel, openaiLunaModel } from "./http-model";
import { reviewDepths, type ReviewDepth } from "./investigation";
import { readText } from "./read-text";
import {
	comparisonArms,
	comparisonRequest,
	comparisonSelection,
	type ComparisonArm,
} from "./rubrics";
import { scopeSelectionSchema } from "./scope";

const help = [
	"bun run quick <request.json|-> --fixture <response.json> [--arm A|B|C|D]",
	"bun run quick <request.json|-> --openai [--arm A|B|C|D]",
	"--openai --codex-sdk-low で Codex SDK の Luna (low) を使います。",
	"bun run quick <request.json|-> --endpoint <chat-completions-url> --model <model> [--arm A|B|C|D]",
	"--scope <scope.json> --preview で確認し、実行時は --scope と --expected-scope-digest <digest> を指定します。",
	"--scope と --depth standard で追加資料を取得します。--depth recheck は同じ資料で二回確認します。",
	"二段階の固定応答は --fixture <調査.json> --fixture <最終判定.json> の順に指定します。",
	"--steer は Standard の調査中に、許可済み資料の ID を標準入力から一行ずつ受け付けます。",
].join("\n");

async function readInput(file: string, limit: number, stdin = false) {
	try {
		return await readText(
			stdin ? Bun.stdin.stream() : Bun.file(file).stream(),
			limit,
		);
	} catch {
		throw new Error(
			stdin
				? "標準入力を読み込めませんでした"
				: `ファイルを読み込めませんでした (${file})`,
		);
	}
}

async function readJsonInput(file: string, stdin = false): Promise<unknown> {
	const text = await readInput(file, MAX_INPUT_BYTES, stdin);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(
			`JSON を読み取れませんでした (${stdin ? "標準入力" : file})`,
		);
	}
}

async function main() {
	const { positionals, values } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			fixture: { type: "string", multiple: true },
			openai: { type: "boolean" },
			"codex-sdk-low": { type: "boolean" },
			steer: { type: "boolean" },
			endpoint: { type: "string" },
			model: { type: "string" },
			arm: { type: "string" },
			scope: { type: "string" },
			preview: { type: "boolean" },
			"expected-scope-digest": { type: "string" },
			depth: { type: "string" },
		},
	});
	if (values.help) {
		console.log(help);
		return;
	}
	const [file] = positionals;
	if (!file || positionals.length !== 1) throw new Error(help);
	const arm = values.arm as ComparisonArm | undefined;
	const depth = (values.depth ?? "quick") as ReviewDepth;
	if (!reviewDepths.includes(depth))
		throw new Error("--depth は quick、recheck、standard のいずれかです");
	if (arm && !comparisonArms.includes(arm))
		throw new Error("比較条件は A、B、C、D のいずれかです");
	if (values["codex-sdk-low"] && !values.openai)
		throw new Error("--codex-sdk-low には --openai が必要です");
	if (
		values.steer &&
		(file === "-" || depth !== "standard" || !values.scope || values.preview)
	)
		throw new Error(
			"--steer にはファイルの依頼、--depth standard、--scope が必要です",
		);
	let input = await readJsonInput(file, file === "-");
	if (arm) {
		const parsed = requestSchema.safeParse(input);
		if (parsed.success) input = comparisonRequest(parsed.data, arm);
	}
	let selection: unknown =
		values.scope === undefined ? undefined : await readJsonInput(values.scope);
	if (arm && selection !== undefined) {
		const parsed = scopeSelectionSchema.safeParse(selection);
		if (parsed.success) selection = comparisonSelection(parsed.data, arm);
	}
	if (values.preview) {
		if (selection === undefined)
			throw new Error("--preview には --scope が必要です");
		console.log(JSON.stringify(previewScope(input, selection), null, 2));
		return;
	}
	const expectedScopeDigest = values["expected-scope-digest"];
	if (selection !== undefined && !expectedScopeDigest)
		throw new Error(
			"--preview で確認した digest を --expected-scope-digest に指定してください",
		);

	let model: EvaluationModel;
	if (values.openai) {
		if (
			values.fixture !== undefined ||
			values.endpoint !== undefined ||
			values.model !== undefined
		)
			throw new Error(
				"--openai は GPT-6 Luna 専用です。--fixture、--endpoint、--model との併用はできません",
			);
		model = values["codex-sdk-low"]
			? (await import("./bench/codex-sdk")).codexSdkLunaModel({
					reasoningEffort: "low",
				}).model
			: openaiLunaModel();
	} else if (values.fixture && !values.endpoint && !values.model) {
		const fixtures = values.fixture;
		if (fixtures.length !== (depth === "quick" ? 1 : 2))
			throw new Error(
				"--fixture は Quick で1回、二段階の評価では調査・最終判定の順に2回指定してください",
			);
		const responses = await Promise.all(
			fixtures.map((path) => readInput(path, MAX_RESPONSE_BYTES)),
		);
		let next = 0;
		model = {
			async complete() {
				return { text: responses[next++]!, model: "fixture" };
			},
		};
	} else if (!values.fixture && values.endpoint && values.model) {
		model = httpModel(values.endpoint, values.model, Bun.env.EVALUATOR_API_KEY);
	} else {
		throw new Error(help);
	}

	const controller = new AbortController();
	const preview = values.steer ? previewScope(input, selection) : undefined;
	const steering =
		preview && preview.digest === expectedScopeDigest
			? await openSteeringConsole(preview)
			: undefined;
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		const result = await evaluate(input, {
			model,
			signal: controller.signal,
			selection,
			expectedScopeDigest,
			depth,
			steering: steering?.target,
		});
		console.log(JSON.stringify(arm ? { arm, ...result } : result, null, 2));
		process.exitCode =
			result.status === "completed"
				? 0
				: result.status === "incomplete"
					? 2
					: 1;
	} finally {
		steering?.close();
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "評価を開始できませんでした",
	);
	process.exitCode = 1;
});
