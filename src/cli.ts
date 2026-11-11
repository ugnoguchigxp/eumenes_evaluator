import { parseArgs } from "node:util";
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
	type ComparisonArm,
} from "./rubrics";

const help = [
	"bun run quick <request.json|-> --fixture <response.json> [--arm A|B|C|D]",
	"bun run quick <request.json|-> --openai [--arm A|B|C|D]",
	"bun run quick <request.json|-> --endpoint <chat-completions-url> --model <model> [--arm A|B|C|D]",
	"--scope <scope.json> --preview で確認し、実行時は --scope と --expected-scope-digest <digest> を指定します。",
	"--scope と --depth standard で追加資料を取得します。--depth recheck は同じ資料で二回確認します。",
].join("\n");

async function main() {
	const { positionals, values } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			fixture: { type: "string" },
			openai: { type: "boolean" },
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
	const text = await readText(
		file === "-" ? Bun.stdin.stream() : Bun.file(file).stream(),
		MAX_INPUT_BYTES,
	);
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		input = null;
	}
	if (arm) {
		const parsed = requestSchema.safeParse(input);
		if (parsed.success) input = comparisonRequest(parsed.data, arm);
	}
	const selection: unknown =
		values.scope === undefined
			? undefined
			: JSON.parse(
					await readText(Bun.file(values.scope).stream(), MAX_INPUT_BYTES),
				);
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
		model = openaiLunaModel();
	} else if (values.fixture && !values.endpoint && !values.model) {
		const response = await readText(
			Bun.file(values.fixture).stream(),
			MAX_RESPONSE_BYTES,
		);
		model = {
			async complete() {
				return { text: response, model: "fixture" };
			},
		};
	} else if (!values.fixture && values.endpoint && values.model) {
		model = httpModel(values.endpoint, values.model, Bun.env.EVALUATOR_API_KEY);
	} else {
		throw new Error(help);
	}

	const controller = new AbortController();
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
		});
		console.log(JSON.stringify(arm ? { arm, ...result } : result, null, 2));
		process.exitCode =
			result.status === "completed"
				? 0
				: result.status === "incomplete"
					? 2
					: 1;
	} finally {
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
