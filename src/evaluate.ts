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
	type ModelRequest,
	type ModelResponse,
	type ReviewEvidence,
} from "./contracts";
import {
	acquireEvidence,
	combinedUsage,
	investigationInstructions,
	investigationSchema,
	readInvestigation,
	registerQuestions,
	reviewDepths,
	settleQuestions,
	verificationInstructions,
	verificationOutputSchema,
	type ReviewDepth,
	type ReviewQuestion,
	type QuestionCheck,
	type ReviewStage,
} from "./investigation";
import { reviewContext, rubricInstructions } from "./rubrics";
import {
	evidenceCoordinates,
	evaluationInputDigest,
	resolveScope,
	ScopeError,
	type ResolvedScope,
} from "./scope";
import {
	activeConditions,
	fingerprint,
	locationExists,
	targetDigests,
	targetEvidence,
} from "./snapshot";

const outputSchema = modelOutputSchema.toJSONSchema();
const stagedOutputSchema = verificationOutputSchema.toJSONSchema();
const inputBudgetExceeded = Symbol("prompt_size_limit");

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function checkInput(
	request: EvaluationRequest,
	primary: Evidence[],
	materials: Evidence[],
): string | undefined {
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

function referenceError(
	output: ModelOutput,
	materials: Map<string, ReviewEvidence>,
	scope: Set<string>,
	primaryIds: Set<string>,
	conditionIds: string[],
): string | undefined {
	const { findings, scopeChecks, conditionChecks } = output;
	if (
		!unique(scopeChecks.map((entry) => entry.evidenceId)) ||
		!unique(conditionChecks.map((entry) => entry.conditionId))
	)
		return "duplicate_checks";

	for (const check of scopeChecks) {
		if (
			!scope.has(check.evidenceId) ||
			(check.status === "unverified" && !check.reason)
		)
			return "invalid_scope_check";
	}

	const conditions = new Map(
		conditionChecks.map((check) => [check.conditionId, check.status]),
	);
	const reportedViolations = new Set(
		findings.map((finding) => finding.conditionId),
	);
	for (const check of conditionChecks) {
		if (
			!conditionIds.includes(check.conditionId) ||
			(check.status !== "unverified" && check.evidence.length === 0) ||
			(check.status === "violated" &&
				!reportedViolations.has(check.conditionId)) ||
			!check.evidence.every((location) => locationExists(materials, location))
		)
			return "invalid_condition_check";
	}
	for (const finding of findings) {
		if (
			!scope.has(finding.primary.evidenceId) ||
			!primaryIds.has(finding.primary.evidenceId)
		)
			return "finding_primary_outside_selection";
		if (
			finding.conditionId !== null &&
			conditions.get(finding.conditionId) !== "violated"
		)
			return "finding_without_matching_violation";
		if (
			![finding.primary, ...finding.evidence].every((location) =>
				locationExists(materials, location),
			)
		)
			return "finding_location_unavailable";
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
			if (!item || item.clipped) {
				return {
					evidenceId,
					status: "unverified",
					reason: item ? "資料が切り詰められています" : "資料がありません",
				};
			}
			return (
				scopeChecks.get(evidenceId) ?? {
					evidenceId,
					status: "unverified",
					reason: "モデルから確認結果が返りませんでした",
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
						: "モデルから確認結果が返りませんでした",
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
): { output: ModelOutput; questionChecks: QuestionCheck[] } | undefined {
	try {
		const json = JSON.parse(text);
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

export async function evaluate(
	input: unknown,
	{
		model,
		signal: parent,
		selection,
		expectedScopeDigest,
		depth = "quick",
	}: {
		model: EvaluationModel;
		signal?: AbortSignal;
		selection?: unknown;
		expectedScopeDigest?: string;
		depth?: ReviewDepth;
	},
): Promise<EvaluationResult> {
	const started = performance.now();
	const parsed = requestSchema.safeParse(input);
	const request = parsed.success ? parsed.data : undefined;
	const target = request?.target;
	const stages: ReviewStage[] = [];
	let questions: ReviewQuestion[] = [];
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
			durationMs: Math.round(performance.now() - started),
			model: response?.model ?? stages.findLast((stage) => stage.model)?.model,
			usage: depth === "quick" ? response?.usage : combinedUsage(stages),
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
		if (
			expectedScopeDigest !== undefined &&
			expectedScopeDigest !== resolved.summary.digest
		)
			return finish("failed", [{ code: "scope_preview_mismatch" }]);
	}

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
	const unavailableConditions = resolved?.unavailableConditions ?? [];
	const scopeIds = resolved?.scopeIds ?? request.scope;
	const issues: EvaluationResult["issues"] = [];
	const empty = () =>
		completeCoverage(
			{ findings: [], scopeChecks: [], conditionChecks: [] },
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
	if (!resolved && conditions.hasInactiveSources)
		issues.push({ code: "condition_sources_inactive" });
	if (unavailableConditions.length)
		issues.push({
			code: "required_conditions_unavailable",
			detail: unavailableConditions.join(", "),
		});
	const scope = new Set(scopeIds);
	const primaryIds = new Set(selected.map((item) => item.id));
	if (!selected.some((item) => scope.has(item.id))) {
		return finish(
			"incomplete",
			[...issues, { code: "target_scope_missing" }],
			empty(),
		);
	}

	const system =
		rubricInstructions(request.rubric) +
		(resolved
			? "\nfindings の primary には primaryEvidenceIds にある ID を指定してください。scope に含まれていても補足資料は evidence に引用してください。pointerRoot がある資料の位置は、その値を先頭に持つ元文書上の絶対 JSON Pointer で返してください。"
			: "");
	const packet = {
		target: baseline.target,
		scope: scopeIds,
		primaryEvidenceIds: resolved ? [...primaryIds] : undefined,
		evidence: materials,
		focus: resolved?.focus,
		originalRequest: request.originalRequest,
		conditions: entries.map(({ id, text, sources }) => ({
			id,
			text,
			sources: sources.map(({ id, version }) => ({ id, version })),
		})),
	};
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

	const controller = new AbortController();
	const cancel = () => controller.abort("cancelled");
	function checkDeadline() {
		if (performance.now() >= deadline) {
			controller.abort("deadline_exceeded");
		}
		controller.signal.throwIfAborted();
	}
	parent?.addEventListener("abort", cancel, { once: true });
	let rejectAbort: (reason: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const interrupt = () => rejectAbort(controller.signal.reason);
	// The first stage can fail before any model call is started.
	void aborted.catch(() => {});
	controller.signal.addEventListener("abort", interrupt, { once: true });
	async function complete(
		phase: ReviewStage["phase"],
		instructions: string,
		input: object,
		schema: ModelRequest["outputSchema"],
	) {
		checkDeadline();
		const prompt = JSON.stringify(input);
		if (
			Buffer.byteLength(instructions) + Buffer.byteLength(prompt) >
			limits.maxInputBytes
		)
			throw inputBudgetExceeded;
		const invocation = {
			system: instructions,
			prompt,
			outputSchema: schema,
			maxOutputTokens: limits.maxOutputTokens,
		};
		const stage: ReviewStage = {
			phase,
			status: "failed",
			inputDigest: fingerprint(invocation),
			durationMs: 0,
		};
		stages.push(stage);
		const start = performance.now();
		const stageDeadline = Math.min(deadline, start + limits.timeoutMs);
		const timer = setTimeout(
			() => controller.abort("deadline_exceeded"),
			Math.ceil(stageDeadline - start),
		);
		try {
			const response = await Promise.race([
				aborted,
				Promise.resolve().then(() => {
					checkDeadline();
					return model.complete(invocation, controller.signal);
				}),
			]);
			stage.model = response.model;
			stage.usage = response.usage;
			if (performance.now() >= stageDeadline)
				controller.abort("deadline_exceeded");
			checkDeadline();
			return { response, stage };
		} finally {
			clearTimeout(timer);
			stage.durationMs = Math.round(performance.now() - start);
			if (controller.signal.aborted)
				stage.status =
					controller.signal.reason === "deadline_exceeded"
						? "expired"
						: "cancelled";
		}
	}
	try {
		let verification = packet;
		let instructions = system;
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
				[...reviewContext(request.rubric), investigationInstructions].join(
					"\n",
				),
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
			const acquired = acquireEvidence(plan, catalog, evidence);
			questions = registerQuestions(plan.openQuestions);
			first.stage.status = "completed";
			first.stage.requested = acquired.requested;
			first.stage.questions = plan.requests;
			first.stage.acquired = acquired.acquired.map((item) => item.id);
			first.stage.unavailable = acquired.unavailable;
			for (const item of acquired.acquired) evidence.set(item.id, item);
			if (acquired.unavailable.length)
				issues.push({ code: "investigation_evidence_unavailable" });
			instructions += "\n" + verificationInstructions;
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
		}
		const { response, stage } = await complete(
			"verification",
			instructions,
			verification,
			depth === "quick" ? outputSchema : stagedOutputSchema,
		);
		const output =
			typeof response.text === "string" &&
			Buffer.byteLength(response.text) <= MAX_RESPONSE_BYTES
				? parseModelOutput(response.text, depth !== "quick")
				: undefined;
		checkDeadline();
		if (!output)
			return finish(
				"failed",
				[...issues, { code: "invalid_model_output" }],
				empty(),
				response,
			);
		const referenceIssue = referenceError(
			output.output,
			evidence,
			scope,
			primaryIds,
			conditionIds,
		);
		checkDeadline();
		if (referenceIssue) {
			return finish(
				"failed",
				[
					...issues,
					{ code: "invalid_model_references", detail: referenceIssue },
				],
				empty(),
				response,
			);
		}
		const reviewedQuestions = settleQuestions(
			questions,
			output.questionChecks,
			evidence,
		);
		if (!reviewedQuestions)
			return finish(
				"failed",
				[
					...issues,
					{
						code: "invalid_model_references",
						detail: "invalid_question_check",
					},
				],
				empty(),
				response,
			);
		questions = reviewedQuestions;
		if (questions.some((item) => item.status === "unverified"))
			issues.push({ code: "investigation_questions_unverified" });
		const checked = completeCoverage(
			output.output,
			scopeIds,
			evidence,
			conditionIds,
			unavailableConditions,
		);
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
		if (controller.signal.reason === "deadline_exceeded")
			return finish(
				"expired",
				[...issues, { code: "deadline_exceeded" }],
				empty(),
			);
		if (controller.signal.aborted)
			return finish("cancelled", [...issues, { code: "cancelled" }], empty());
		if (error === inputBudgetExceeded)
			return finish(
				"incomplete",
				[...issues, { code: "prompt_size_limit" }],
				empty(),
			);
		return finish(
			"failed",
			[...issues, { code: "model_request_failed" }],
			empty(),
		);
	} finally {
		parent?.removeEventListener("abort", cancel);
		controller.signal.removeEventListener("abort", interrupt);
	}
}
