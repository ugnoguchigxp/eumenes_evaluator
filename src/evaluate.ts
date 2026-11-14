import {
	MAX_INPUT_BYTES,
	MAX_RESPONSE_BYTES,
	modelOutputSchema,
	requestSchema,
	type EvaluationModel,
	type EvaluationRequest,
	type EvaluationResult,
	type Evidence,
	type ModelOutput,
	type IssueCode,
	type ModelResponse,
	type ReviewEvidence,
} from "./contracts";
import { ModelError } from "./http-model";
import {
	acquireEvidence,
	combinedUsage,
	investigationInstructions,
	investigationSchema,
	readInvestigation,
	registerQuestions,
	standardEvidenceInstructions,
	reviewDepths,
	verificationInstructions,
	verificationOutputSchema,
	type ReviewDepth,
	type ReviewQuestion,
	type QuestionCheck,
	type ReviewStage,
} from "./investigation";
import {
	inputBudgetExceeded,
	startModelStages,
	type ModelDelivery,
	type ModelInput,
} from "./model-stages";
import { validateReferences } from "./output";
import { prepareSteeredVerification, type SteeringTarget } from "./steering";
import {
	reviewContext,
	rubricInstructions,
	scopedReviewInstructions,
} from "./rubrics";
import {
	evidenceCoordinates,
	evaluationInputDigest,
	resolveScope,
	ScopeError,
	type ResolvedScope,
} from "./scope";
import { activeConditions, targetDigests, targetEvidence } from "./snapshot";
import {
	workflowRowInstructions,
	workflowRowOutput,
	workflowRowSchema,
} from "./workflow-rows";

const outputSchema = modelOutputSchema.toJSONSchema();
const stagedOutputSchema = verificationOutputSchema.toJSONSchema();

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function checkInput(
	request: EvaluationRequest,
	primary: Evidence[],
	materials: Evidence[],
): IssueCode | undefined {
	const { target, rubric, conditions, scope } = request;
	if ((target.kind === "workflow") !== (rubric.id === "workflow-correctness")) {
		return "rubric_target_mismatch";
	}
	if (target.kind === "code") {
		const { digest, diffDigest, ...content } = target;
		const expected = targetDigests(content);
		if (expected.digest !== digest || expected.diffDigest !== diffDigest)
			return "target_digest_mismatch";
		if (
			target.base.length !== target.head.length ||
			!unique(target.changes.map((change) => change.id))
		)
			return "invalid_diff";
	} else if (targetDigests(target).digest !== target.digest) {
		return "target_digest_mismatch";
	}
	if (!unique(materials.map((item) => item.id)) || !unique(scope)) {
		return "duplicate_evidence_or_scope";
	}
	if (
		conditions.state === "available" &&
		!unique(conditions.entries.map((entry) => entry.id))
	) {
		return "duplicate_condition";
	}
	if (primary.some((item) => item.kind === "lines" && !item.text))
		return "empty_diff_excerpt";
	for (const item of materials) {
		const version =
			target.kind === "code" && item.kind === "lines"
				? target[item.side]
				: target.version;
		if (item.version !== version) return "evidence_version_mismatch";
	}
}

function completeCoverage(
	output: ModelOutput,
	scopeIds: string[],
	materials: Map<string, ReviewEvidence>,
	conditionIds: string[],
	unavailableConditions: string[],
): ModelOutput {
	const scopeChecks = new Map(
		output.scopeChecks.map((check) => [check.evidenceId, check]),
	);
	const conditionChecks = new Map(
		output.conditionChecks.map((check) => [check.conditionId, check]),
	);
	return {
		findings: output.findings,
		scopeChecks: scopeIds.map((evidenceId) => {
			const item = materials.get(evidenceId);
			if (!item || item.clipped || (item.kind === "lines" && !item.text)) {
				return {
					evidenceId,
					status: "unverified",
					reason: item?.clipped
						? "資料が切り詰められています"
						: "資料がありません",
				};
			}
			return (
				scopeChecks.get(evidenceId) ?? {
					evidenceId,
					status: "unverified",
					reason: "モデルから有効な確認結果が返りませんでした",
				}
			);
		}),
		conditionChecks: [...conditionIds, ...unavailableConditions].map(
			(conditionId) =>
				conditionChecks.get(conditionId) ?? {
					conditionId,
					status: "unverified",
					reason: unavailableConditions.includes(conditionId)
						? "対象版に適用できる確定条件を取得できませんでした"
						: "モデルから有効な確認結果が返りませんでした",
					evidence: [],
				},
		),
	};
}

export function previewScope(input: unknown, selection: unknown) {
	const request = requestSchema.parse(input);
	const primary = targetEvidence(request.target);
	const error = checkInput(request, primary, [...primary, ...request.evidence]);
	if (error) throw new ScopeError(error);
	return resolveScope(request, selection).summary;
}

function parseModelOutput(
	text: string,
	staged: boolean,
	compareRows?: (json: unknown) => ModelOutput | undefined,
): { output: ModelOutput; questionChecks: QuestionCheck[] } | undefined {
	try {
		const json = JSON.parse(text);
		if (compareRows) {
			const output = compareRows(json);
			if (output) return { output, questionChecks: [] };
			return;
		}
		if (
			staged &&
			json &&
			typeof json === "object" &&
			Object.hasOwn(json, "questionChecks")
		) {
			const parsed = verificationOutputSchema.safeParse(json);
			if (!parsed.success) return;
			const { questionChecks, ...output } = parsed.data;
			return { output, questionChecks };
		}
		// Older adapters may omit the question checks. Any registered question then stays unverified.
		const parsed = modelOutputSchema.safeParse(json);
		if (parsed.success) return { output: parsed.data, questionChecks: [] };
	} catch {
		return undefined;
	}
}

function prepareReview(
	request: EvaluationRequest,
	target: EvaluationResult["target"],
	primary: Evidence[],
	resolved: ResolvedScope | undefined,
) {
	const selected = resolved?.primary ?? primary;
	const materials = [
		...selected,
		...(resolved?.initialEvidence ?? request.evidence),
	];
	const evidence = new Map(materials.map((item) => [item.id, item]));
	const conditions = activeConditions(request);
	const entries = resolved
		? conditions.entries.filter((item) =>
				resolved.summary.conditionIds.includes(item.id),
			)
		: conditions.entries;
	const conditionIds = entries.map((entry) => entry.id);
	const conditionSelection = {
		applied: conditionIds,
		excluded: conditions.excluded,
	};
	const unavailableConditions = resolved?.unavailableConditions ?? [];
	const scopeIds = resolved?.scopeIds ?? request.scope;
	const issues: EvaluationResult["issues"] = [];
	const cover = (output: ModelOutput) =>
		completeCoverage(
			output,
			scopeIds,
			evidence,
			conditionIds,
			unavailableConditions,
		);
	if (
		request.conditions.state === "unavailable" &&
		(!resolved || resolved.summary.conditionIds.length > 0)
	)
		issues.push({
			code: "conditions_unavailable",
			detail: request.conditions.reason,
		});
	if (!resolved) {
		if (conditions.excluded.some(({ reason }) => reason === "source_inactive"))
			issues.push({ code: "condition_sources_inactive" });
		for (const { id, reason } of conditions.excluded) {
			if (reason === "target_mismatch")
				issues.push({ code: "condition_target_mismatch", detail: id });
		}
	}
	if (unavailableConditions.length)
		issues.push({
			code: "required_conditions_unavailable",
			detail: unavailableConditions.join(", "),
		});
	const scope = new Set(scopeIds);
	const primaryIds = new Set(selected.map((item) => item.id));
	return {
		selected,
		primaryIds,
		conditionIds,
		conditionSelection,
		scope,
		issues,
		evidence,
		cover,
		packet: {
			target,
			scope: scopeIds,
			primaryEvidenceIds: resolved ? [...primaryIds] : undefined,
			evidence: materials,
			focus: resolved?.focus,
			skillMarkdown: request.skillMarkdown,
			originalRequest: request.originalRequest,
			conditions: entries.map(({ id, text, sources }) => ({
				id,
				text,
				sources: sources.map(({ id, version }) => ({ id, version })),
			})),
		},
	};
}

export async function evaluate(
	input: unknown,
	{
		model,
		signal: parent,
		selection,
		expectedScopeDigest,
		steering,
		depth = "quick",
	}: {
		model: EvaluationModel;
		signal?: AbortSignal;
		selection?: unknown;
		expectedScopeDigest?: string;
		steering?: SteeringTarget;
		depth?: ReviewDepth;
	},
): Promise<EvaluationResult> {
	const started = performance.now();
	const parsed = requestSchema.safeParse(input);
	const request = parsed.success ? parsed.data : undefined;
	const target = request?.target;
	const stages: ReviewStage[] = [];
	let questions: ReviewQuestion[] = [];
	let rejected: EvaluationResult["rejected"] = [];
	let steeringReceipt: EvaluationResult["steering"];
	const baseline = {
		contractVersion: 1 as const,
		evaluationId: request?.evaluationId ?? null,
		rubric: request?.rubric ?? null,
		target: target
			? {
					kind: target.kind,
					id: target.id,
					version: target.version,
					digest: target.digest,
				}
			: null,
		inputDigest: null as string | null,
		scopeSelection: undefined as EvaluationResult["scopeSelection"],
		conditionSelection: {
			applied: [],
			excluded: [],
		} as EvaluationResult["conditionSelection"],
		conditions: request?.conditions.state ?? null,
		conditionRevision:
			request?.conditions.state === "available"
				? request.conditions.revision
				: null,
	};
	function finish(
		status: EvaluationResult["status"],
		issues: EvaluationResult["issues"] = [],
		output: ModelOutput = {
			findings: [],
			scopeChecks: [],
			conditionChecks: [],
		},
		response?: ModelResponse,
	): EvaluationResult {
		return {
			...baseline,
			...output,
			status,
			issues,
			rejected,
			durationMs: Math.round(performance.now() - started),
			model: response?.model ?? stages.findLast((stage) => stage.model)?.model,
			usage: depth === "quick" ? response?.usage : combinedUsage(stages),
			...(steeringReceipt ? { steering: steeringReceipt } : {}),
			...(depth !== "quick" ? { review: { depth, stages, questions } } : {}),
		};
	}
	if (!request) {
		const detail = parsed.error?.issues
			.slice(0, 6)
			.map((issue) => issue.path.join(".") + " (" + issue.code + ")")
			.join(", ");
		return finish("failed", [{ code: "invalid_request", detail }]);
	}
	const encoded = JSON.stringify(request);
	if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
		return finish("incomplete", [{ code: "request_size_limit" }]);
	}
	baseline.inputDigest = evaluationInputDigest(request, undefined);
	const primary = targetEvidence(request.target);
	const inputError = checkInput(request, primary, [
		...primary,
		...request.evidence,
	]);
	if (inputError) return finish("failed", [{ code: inputError }]);
	if (parent?.aborted) return finish("cancelled", [{ code: "cancelled" }]);
	if (!reviewDepths.includes(depth))
		return finish("failed", [{ code: "invalid_review_depth" }]);
	if (steering && depth !== "standard")
		return finish("failed", [{ code: "steering_requires_standard" }]);
	if (depth !== "quick" && selection === undefined)
		return finish("failed", [{ code: "scope_required_for_depth" }]);
	if (expectedScopeDigest !== undefined && selection === undefined)
		return finish("failed", [{ code: "scope_required_for_preview_digest" }]);
	let resolved: ResolvedScope | undefined;
	if (selection !== undefined) {
		try {
			resolved = resolveScope(request, selection);
		} catch (error) {
			if (!(error instanceof ScopeError)) throw error;
			return finish("failed", [{ code: error.code, detail: error.message }]);
		}
		baseline.scopeSelection = resolved.summary;
		baseline.inputDigest = evaluationInputDigest(request, resolved, depth);
		if (resolved.currentValuePointer !== undefined && depth !== "quick")
			return finish("failed", [
				{
					code: "invalid_scope_selection",
					detail: "currentValuePointer requires Quick",
				},
			]);
		if (
			expectedScopeDigest !== undefined &&
			expectedScopeDigest !== resolved.summary.digest
		)
			return finish("failed", [{ code: "scope_preview_mismatch" }]);
	}

	const {
		selected,
		primaryIds,
		conditionIds,
		conditionSelection,
		scope,
		issues,
		evidence,
		packet,
		cover,
	} = prepareReview(request, baseline.target, primary, resolved);
	baseline.conditionSelection = conditionSelection;
	const empty = () =>
		cover({ findings: [], scopeChecks: [], conditionChecks: [] });
	if (!selected.some((item) => scope.has(item.id))) {
		return finish(
			"incomplete",
			[...issues, { code: "target_scope_missing" }],
			empty(),
		);
	}

	const currentValuePointer = resolved?.currentValuePointer;
	const rowLabelPointer = resolved?.rowLabelPointer;
	const expectedValues = resolved?.expectedValues;
	const comparisonPointers =
		resolved?.summary.selected.flatMap((item) =>
			currentValuePointer !== undefined && "pointerRoot" in item
				? [item.pointerRoot + currentValuePointer]
				: [],
		) ?? [];
	const compareRows =
		currentValuePointer === undefined
			? undefined
			: (json: unknown) =>
					workflowRowOutput(
						json,
						selected,
						evidence,
						scope,
						currentValuePointer,
						conditionIds,
						rowLabelPointer,
						expectedValues,
					);
	const system = compareRows
		? [...reviewContext(request.rubric), workflowRowInstructions].join("\n")
		: rubricInstructions(request.rubric) +
			(resolved ? "\n" + scopedReviewInstructions : "");
	const { limits } = request;
	const budgetMs =
		depth === "quick"
			? limits.timeoutMs
			: Math.min(180_000, limits.timeoutMs * 2);
	const deadline = started + budgetMs;
	const remaining = deadline - performance.now();
	if (remaining <= 0)
		return finish(
			"expired",
			[...issues, { code: "deadline_exceeded" }],
			empty(),
		);

	const runner = startModelStages(model, parent, limits, deadline, stages);
	const { complete, checkDeadline } = runner;
	try {
		let verification: ModelInput = compareRows
			? {
					...packet,
					currentValuePointer,
					rowLabelPointer,
					comparisonPointers,
					expectedValues,
				}
			: packet;
		let instructions = system;
		let steered: ReturnType<typeof prepareSteeredVerification>;
		if (depth !== "quick") {
			const catalog = new Map(
				(depth === "standard" ? resolved!.catalog : []).map((item) => [
					item.id,
					item,
				]),
			);
			const evidenceCatalog = [...catalog.values()]
				.filter((item) => !evidence.has(item.id))
				.map(evidenceCoordinates);
			const first = await complete(
				"investigation",
				[
					...reviewContext(request.rubric),
					investigationInstructions,
					...(depth === "standard"
						? [standardEvidenceInstructions.investigation]
						: []),
				].join("\n"),
				{ ...packet, evidenceCatalog },
				investigationSchema,
			);
			const plan = readInvestigation(first.response.text);
			checkDeadline();
			if (!plan)
				return finish(
					"failed",
					[...issues, { code: "invalid_investigation_output" }],
					empty(),
					first.response,
				);
			const acquired = acquireEvidence(
				plan,
				catalog,
				evidence,
				depth === "standard" ? resolved!.summary.requiredEvidenceIds : [],
			);
			questions = registerQuestions(plan.openQuestions);
			first.stage.status = "completed";
			first.stage.requested = acquired.requested;
			first.stage.questions = plan.requests;
			first.stage.acquired = acquired.acquired.map((item) => item.id);
			if (depth === "standard")
				first.stage.requiredAcquired = acquired.requiredAcquired;
			first.stage.unavailable = acquired.unavailable;
			for (const item of acquired.acquired) evidence.set(item.id, item);
			if (acquired.unavailable.length)
				issues.push({ code: "investigation_evidence_unavailable" });
			instructions += "\n" + verificationInstructions;
			if (depth === "standard")
				instructions += "\n" + standardEvidenceInstructions.verification;
			const finalPacket = {
				...packet,
				evidence: [...evidence.values()],
				investigation: {
					hypotheses: plan.hypotheses,
					openQuestions: questions.map(({ questionId, question }) => ({
						questionId,
						question,
					})),
					questions: plan.requests,
					unavailableEvidenceIds: acquired.unavailable,
				},
			};
			verification = finalPacket;
			if (steering) {
				steered = prepareSteeredVerification(
					steering,
					catalog,
					evidence,
					instructions,
					finalPacket,
					limits.maxInputBytes,
				);
				if (steered) {
					verification = steered.packet;
					instructions = steered.instructions;
				}
			}
		}
		const delivery: ModelDelivery | undefined = steered
			? { dispatched: false, responded: false }
			: undefined;
		const { response, stage } = await complete(
			"verification",
			instructions,
			verification,
			compareRows
				? workflowRowSchema(
						comparisonPointers,
						[...evidence.values()]
							.filter((item) => item.kind === "json" && !item.clipped)
							.map(({ id }) => id),
						expectedValues,
					)
				: depth === "quick"
					? outputSchema
					: stagedOutputSchema,
			delivery,
		).finally(() => {
			if (delivery && steered) steeringReceipt = steered.settle(delivery);
		});
		const output =
			typeof response.text === "string" &&
			Buffer.byteLength(response.text) <= MAX_RESPONSE_BYTES
				? parseModelOutput(response.text, depth !== "quick", compareRows)
				: undefined;
		checkDeadline();
		if (!output)
			return finish(
				"failed",
				[...issues, { code: "invalid_model_output" }],
				empty(),
				response,
			);
		const validated = validateReferences(
			output.output,
			output.questionChecks,
			questions,
			evidence,
			scope,
			primaryIds,
			conditionIds,
		);
		checkDeadline();
		questions = validated.questions;
		rejected = validated.rejected;
		if (rejected.length)
			issues.push({ code: "model_output_partially_rejected" });
		if (questions.some((item) => item.status === "unverified"))
			issues.push({ code: "investigation_questions_unverified" });
		const checked = cover(validated.output);
		stage.status = "completed";
		if (checked.scopeChecks.some((check) => check.status === "unverified"))
			issues.push({ code: "scope_unverified" });
		if (checked.conditionChecks.some((check) => check.status === "unverified"))
			issues.push({ code: "conditions_unverified" });
		return finish(
			issues.length > 0 ? "incomplete" : "completed",
			issues,
			checked,
			response,
		);
	} catch (error) {
		if (runner.signal.reason === "deadline_exceeded")
			return finish(
				"expired",
				[...issues, { code: "deadline_exceeded" }],
				empty(),
			);
		if (runner.signal.aborted)
			return finish("cancelled", [...issues, { code: "cancelled" }], empty());
		if (error === inputBudgetExceeded)
			return finish(
				"incomplete",
				[...issues, { code: "prompt_size_limit" }],
				empty(),
			);
		return finish(
			"failed",
			[
				...issues,
				{
					code: "model_request_failed",
					...(error instanceof ModelError ? { detail: error.kind } : {}),
				},
			],
			empty(),
		);
	} finally {
		runner.close();
	}
}
