import type {
	EvaluationModel,
	EvaluationRequest,
	ModelRequest,
} from "./contracts";
import type { ReviewStage } from "./investigation";
import { fingerprint } from "./snapshot";

export const inputBudgetExceeded = Symbol("prompt_size_limit");

export function fitsModelInput(
	instructions: string,
	prompt: string,
	limit: number,
) {
	return Buffer.byteLength(instructions) + Buffer.byteLength(prompt) <= limit;
}

export type ModelDelivery = { dispatched: boolean; responded: boolean };

export function startModelStages(
	model: EvaluationModel,
	parent: AbortSignal | undefined,
	limits: EvaluationRequest["limits"],
	deadline: number,
	stages: ReviewStage[],
) {
	const controller = new AbortController();
	const cancel = () => controller.abort("cancelled");
	function checkDeadline() {
		if (performance.now() >= deadline) {
			controller.abort("deadline_exceeded");
		}
		controller.signal.throwIfAborted();
	}
	let rejectAbort: (reason: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const interrupt = () => rejectAbort(controller.signal.reason);
	// The first stage can fail before any model call is started.
	void aborted.catch(() => {});
	controller.signal.addEventListener("abort", interrupt, { once: true });
	parent?.addEventListener("abort", cancel, { once: true });
	if (parent?.aborted) cancel();
	async function complete(
		phase: ReviewStage["phase"],
		instructions: string,
		input: object,
		schema: ModelRequest["outputSchema"],
		delivery?: ModelDelivery,
	) {
		checkDeadline();
		const prompt = JSON.stringify(input);
		if (!fitsModelInput(instructions, prompt, limits.maxInputBytes))
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
				Promise.resolve().then(async () => {
					checkDeadline();
					if (delivery) delivery.dispatched = true;
					const response = await model.complete(invocation, controller.signal);
					if (delivery) delivery.responded = true;
					return response;
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
	return {
		signal: controller.signal,
		complete,
		checkDeadline,
		close() {
			parent?.removeEventListener("abort", cancel);
			controller.signal.removeEventListener("abort", interrupt);
		},
	};
}
