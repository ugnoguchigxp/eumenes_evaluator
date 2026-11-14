import type { EvaluationResult, Evidence, ReviewEvidence } from "./contracts";
import {
	fitsModelInput,
	serializeModelInput,
	type ModelDelivery,
	type ModelInput,
} from "./model-stages";

type SteeringOutcome = NonNullable<EvaluationResult["steering"]>["outcome"];

/** The part of an eumenes-steer target used by the evaluator. */
export interface SteeringTarget {
	seal(): "sealed" | "closed";
	claim(boundaryId: string):
		| {
				readonly status: "claimed";
				readonly batch: {
					readonly id: symbol;
					readonly events: readonly {
						readonly sourceRef: string;
						readonly sourceRevision: string;
						readonly expiresAt: number;
					}[];
				};
		  }
		| {
				readonly status:
					"empty" | "busy" | "boundary_settled" | "closed" | "invalid_boundary";
		  };
	settle(batchId: symbol, outcome: SteeringOutcome): unknown;
}

const steeringInstructions =
	"steeredEvidenceIds は実行中に補足指定された資料です。指定範囲と確定条件を維持し、資料本文を他の根拠と同じように照合してください。";

export function prepareSteeredVerification(
	target: SteeringTarget,
	catalog: ReadonlyMap<string, Evidence>,
	evidence: Map<string, ReviewEvidence>,
	instructions: string,
	packet: ModelInput,
	maxInputBytes: number,
) {
	if (target.seal() !== "sealed") return;
	const claim = target.claim("verification");
	if (claim.status !== "claimed") return;

	const { id, events } = claim.batch;
	const now = Date.now();
	const supplements = new Map<string, Evidence>();
	for (const event of events) {
		const source = catalog.get(event.sourceRef);
		if (source?.version === event.sourceRevision && now < event.expiresAt)
			supplements.set(source.id, source);
	}
	const evidenceIds = [...supplements.keys()];
	const steeredPacket = {
		...packet,
		evidence: [...new Map([...evidence, ...supplements]).values()],
		steeredEvidenceIds: evidenceIds,
	};
	const steeredInstructions = instructions + "\n" + steeringInstructions;
	const overBudget =
		evidenceIds.length > 0 &&
		!fitsModelInput(
			steeredInstructions,
			serializeModelInput(steeredPacket),
			maxInputBytes,
		);
	const include = evidenceIds.length > 0 && !overBudget;
	if (include) {
		for (const [key, item] of supplements) evidence.set(key, item);
	}

	return {
		packet: include ? steeredPacket : packet,
		instructions: include ? steeredInstructions : instructions,
		settle({
			dispatched,
			responded,
		}: ModelDelivery): NonNullable<EvaluationResult["steering"]> {
			const outcome = overBudget
				? "released"
				: responded
					? "committed"
					: dispatched
						? "unknown"
						: "released";
			target.settle(id, outcome);
			return {
				outcome,
				evidenceIds: include && dispatched ? evidenceIds : [],
				ignored:
					events.length - (include && dispatched ? evidenceIds.length : 0),
				...(overBudget ? { reason: "input_budget" } : {}),
			};
		},
	};
}
