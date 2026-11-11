import { z } from "zod";
import {
	MAX_RESPONSE_BYTES,
	id,
	locationSchema,
	modelOutputSchema,
	type Evidence,
	type ModelResponse,
} from "./contracts";

export const reviewDepths = ["quick", "recheck", "standard"] as const;
export type ReviewDepth = (typeof reviewDepths)[number];

const question = z.string().min(1).max(1000);
const planSchema = z.strictObject({
	hypotheses: z.array(question).max(8),
	openQuestions: z.array(question).max(8),
	requests: z.array(z.strictObject({ evidenceId: id, question })).max(8),
});
export const investigationSchema = planSchema.toJSONSchema();
const questionCheckSchema = z.strictObject({
	questionId: id,
	status: z.enum(["resolved", "unverified"]),
	reason: question,
	evidence: z.array(locationSchema).max(12),
});
export const verificationOutputSchema = modelOutputSchema.extend({
	questionChecks: z.array(questionCheckSchema).max(8),
});
export type QuestionCheck = z.infer<typeof questionCheckSchema>;
export type ReviewQuestion = QuestionCheck & { question: string };

export const investigationInstructions = [
	"この段階は調査計画です。指摘候補と、判断に必要だが資料が足りない問いを挙げてください。",
	"指摘候補がない場合も、指定された条件・観点に不足する証拠があれば openQuestions に挙げてください。",
	"evidenceCatalog にある資料が判断や反証に役立つ場合、その ID と確認する問いを requests に指定してください。",
	"evidenceCatalog は資料の一覧であり本文は未取得です。一覧にない資料を要求したり、一覧だけを根拠に確定したりしないでください。",
].join("\n");

export const verificationInstructions = [
	"調査の仮説と未確認事項を読み、今回渡された本文で支持または反証してください。",
	"調査段階の仮説と資料の一覧・取得失敗は根拠ではありません。根拠の成立を独立に判断し、新たな指摘も検討してください。",
	"取得できない証拠が依然として必要なら、該当する範囲または条件を未確認として返してください。",
	"openQuestions の各 questionId を questionChecks に一度ずつ返してください。許可された証拠の位置を引用して解決できる場合は resolved、資料不足や判断不能の場合は unverified としてください。",
].join("\n");

export const standardEvidenceInstructions = {
	investigation:
		"判定を左右する設定値や規則は、対象の参照先をたどって確認できる定義を優先して取得してください。似た名前の候補がある場合は、対象がどの定義を使うかを識別できる資料も選んでください。",
	verification:
		"設定値や規則は、資料内の参照名・解決規則などをたどって照合してください。そのつながりで適用先が特定できれば、根拠として使えます。別の処理や版の定義は代用せず、判定に必要な参照先の定義が見つからなければ、該当する条件または範囲を unverified とし、その定義を前提とした指摘を出さないでください。",
};

export function readInvestigation(text: string) {
	if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return;
	try {
		const parsed = planSchema.safeParse(JSON.parse(text));
		if (parsed.success) return parsed.data;
	} catch {
		return;
	}
}

export function registerQuestions(questions: string[]): ReviewQuestion[] {
	return questions.map((question, index) => ({
		questionId: `question-${index + 1}`,
		question,
		status: "unverified",
		reason: "最終判定で解決を確認できませんでした",
		evidence: [],
	}));
}

export function acquireEvidence(
	plan: NonNullable<ReturnType<typeof readInvestigation>>,
	catalog: Map<string, Evidence>,
	seen: ReadonlyMap<string, unknown>,
	required: readonly string[],
) {
	const requested = [
		...new Set(plan.requests.map(({ evidenceId }) => evidenceId)),
	];
	const acquired: Evidence[] = [];
	const unavailable: string[] = [];
	const requiredAcquired: string[] = [];
	const requestedIds = new Set(requested);
	for (const id of requested) {
		if (seen.has(id)) continue;
		const item = catalog.get(id);
		if (item) acquired.push(item);
		else unavailable.push(id);
	}
	for (const id of required) {
		if (seen.has(id) || requestedIds.has(id)) continue;
		const item = catalog.get(id);
		if (item) {
			acquired.push(item);
			requiredAcquired.push(id);
		}
	}
	return { requested, acquired, unavailable, requiredAcquired };
}

export type ReviewStage = {
	phase: "investigation" | "verification";
	status: "completed" | "failed" | "expired" | "cancelled";
	inputDigest: string;
	durationMs: number;
	model?: string;
	usage?: ModelResponse["usage"];
	requested?: string[];
	questions?: Array<{ evidenceId: string; question: string }>;
	acquired?: string[];
	requiredAcquired?: string[];
	unavailable?: string[];
};

export function combinedUsage(stages: ReviewStage[]): ModelResponse["usage"] {
	const usage = stages.flatMap((stage) => (stage.usage ? [stage.usage] : []));
	if (!usage.length) return;
	const sum = (key: "inputTokens" | "outputTokens") => {
		const values = usage.flatMap((item) =>
			item[key] === undefined ? [] : [item[key]],
		);
		return values.length
			? values.reduce((total, value) => total + value, 0)
			: undefined;
	};
	return { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") };
}
