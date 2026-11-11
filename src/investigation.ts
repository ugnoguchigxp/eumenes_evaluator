import { z } from "zod";
import {
	MAX_RESPONSE_BYTES,
	id,
	locationSchema,
	modelOutputSchema,
	type Evidence,
	type ReviewEvidence,
	type ModelResponse,
} from "./contracts";
import { locationExists } from "./snapshot";

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

export function settleQuestions(
	questions: ReviewQuestion[],
	checks: QuestionCheck[],
	evidence: ReadonlyMap<string, ReviewEvidence>,
): ReviewQuestion[] | undefined {
	const known = new Set(questions.map((item) => item.questionId));
	const byId = new Map(checks.map((item) => [item.questionId, item]));
	if (
		byId.size !== checks.length ||
		checks.some(
			(item) =>
				!known.has(item.questionId) ||
				(item.status === "resolved" && item.evidence.length === 0) ||
				!item.evidence.every((location) => locationExists(evidence, location)),
		)
	)
		return;
	return questions.map((item) => ({ ...item, ...byId.get(item.questionId) }));
}

export function acquireEvidence(
	plan: NonNullable<ReturnType<typeof readInvestigation>>,
	catalog: Map<string, Evidence>,
	seen: ReadonlyMap<string, ReviewEvidence>,
) {
	const requested = [
		...new Set(plan.requests.map(({ evidenceId }) => evidenceId)),
	];
	const acquired: Evidence[] = [];
	const unavailable: string[] = [];
	for (const id of requested) {
		if (seen.has(id)) continue;
		const item = catalog.get(id);
		if (item) acquired.push(item);
		else unavailable.push(id);
	}
	return { requested, acquired, unavailable };
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
