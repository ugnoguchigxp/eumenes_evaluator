import type { ModelOutput, RejectedOutput, ReviewEvidence } from "./contracts";
import type { QuestionCheck, ReviewQuestion } from "./investigation";
import { fingerprint, locationExists } from "./snapshot";

type Indexed<T> = { value: T; index: number };

function validChecks<T>(
	values: T[],
	id: (value: T) => string,
	error: (value: T) => string | undefined,
	reject: (index: number, reason: string) => void,
): Indexed<T>[] {
	const groups = Map.groupBy(
		values.map((value, index) => ({ value, index })),
		({ value }) => id(value),
	);
	const valid: Indexed<T>[] = [];
	for (const group of groups.values()) {
		const first = group[0]!;
		const conflict =
			group.length > 1 &&
			group.some(
				({ value }) => fingerprint(value) !== fingerprint(first.value),
			);
		const reason = conflict ? "conflicting_checks" : error(first.value);
		if (reason) {
			for (const { index } of group) reject(index, reason);
		} else {
			valid.push(first);
		}
	}
	return valid;
}

export function validateReferences(
	output: ModelOutput,
	questionChecks: QuestionCheck[],
	questions: ReviewQuestion[],
	materials: ReadonlyMap<string, ReviewEvidence>,
	scope: ReadonlySet<string>,
	primaryIds: ReadonlySet<string>,
	conditionIds: string[],
) {
	const rejected: RejectedOutput[] = [];
	const reject =
		(kind: RejectedOutput["kind"]) => (index: number, reason: string) =>
			rejected.push({ kind, index, reason });
	const rejectFinding = reject("findings");
	const rejectCondition = reject("conditionChecks");
	const exists = (location: ModelOutput["findings"][number]["primary"]) =>
		locationExists(materials, location);
	const scopeChecks = validChecks(
		output.scopeChecks,
		(check) => check.evidenceId,
		(check) =>
			!scope.has(check.evidenceId) ||
			(check.status === "unverified" && !check.reason)
				? "invalid_scope_check"
				: undefined,
		reject("scopeChecks"),
	);
	const conditionChecks = validChecks(
		output.conditionChecks,
		(check) => check.conditionId,
		(check) =>
			!conditionIds.includes(check.conditionId) ||
			(check.status !== "unverified" && check.evidence.length === 0) ||
			!check.evidence.every(exists)
				? "invalid_condition_check"
				: undefined,
		rejectCondition,
	);
	const conditionById = new Map(
		conditionChecks.map(({ value }) => [value.conditionId, value]),
	);
	const contradictory = new Set<string>();
	const reportedViolations = new Set<string>();
	const findings = output.findings.filter((finding, index) => {
		const { primary, conditionId } = finding;
		if (!scope.has(primary.evidenceId) || !primaryIds.has(primary.evidenceId)) {
			rejectFinding(index, "finding_primary_outside_selection");
		} else if (![primary, ...finding.evidence].every(exists)) {
			rejectFinding(index, "finding_location_unavailable");
		} else if (
			conditionId !== null &&
			conditionById.get(conditionId)?.status !== "violated"
		) {
			contradictory.add(conditionId);
			rejectFinding(index, "finding_without_matching_violation");
		} else {
			if (conditionId !== null) reportedViolations.add(conditionId);
			return true;
		}
		return false;
	});
	const acceptedConditions = conditionChecks.filter(({ value, index }) => {
		if (contradictory.has(value.conditionId) && value.status !== "unverified") {
			rejectCondition(index, "condition_conflicts_with_finding");
		} else if (
			value.status === "violated" &&
			!reportedViolations.has(value.conditionId)
		) {
			rejectCondition(index, "condition_without_matching_finding");
		} else {
			return true;
		}
		return false;
	});

	const knownQuestions = new Set(
		questions.map((question) => question.questionId),
	);
	const acceptedQuestions = validChecks(
		questionChecks,
		(check) => check.questionId,
		(check) =>
			!knownQuestions.has(check.questionId) ||
			(check.status === "resolved" && check.evidence.length === 0) ||
			!check.evidence.every(exists)
				? "invalid_question_check"
				: undefined,
		reject("questionChecks"),
	);
	const byQuestion = new Map(
		acceptedQuestions.map(({ value }) => [value.questionId, value]),
	);
	return {
		output: {
			findings,
			scopeChecks: scopeChecks.map(({ value }) => value),
			conditionChecks: acceptedConditions.map(({ value }) => value),
		},
		questions: questions.map((question) => ({
			...question,
			...byQuestion.get(question.questionId),
		})),
		rejected,
	};
}
