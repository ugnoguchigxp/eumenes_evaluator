import { z } from "zod";
import type { EvaluationModel } from "./contracts";
import { readText } from "./read-text";

export const openaiLuna = "gpt-6-luna";
export const openaiEndpoint = "https://api.openai.com/v1/chat/completions";

export class ModelError extends Error {
	constructor(
		readonly kind:
			| "auth"
			| "rate_limited"
			| "unavailable"
			| "truncated"
			| "refused"
			| "invalid_response",
	) {
		super(kind);
		this.name = "ModelError";
	}
}

export function openaiLunaModel(): EvaluationModel {
	const key = Bun.env.OPEN_AI_API_KEY?.trim();
	if (!key) throw new Error("OPEN_AI_API_KEY を設定してください");
	return httpModel(openaiEndpoint, openaiLuna, key, "max_completion_tokens");
}

const responseSchema = z.object({
	model: z.string().max(256).optional(),
	choices: z
		.array(
			z.object({
				finish_reason: z.string(),
				message: z.object({
					content: z.string().nullish(),
					refusal: z.string().nullish(),
				}),
			}),
		)
		.length(1),
	usage: z
		.object({
			prompt_tokens: z.number().int().nonnegative().optional(),
			completion_tokens: z.number().int().nonnegative().optional(),
		})
		.nullish(),
});

export function httpModel(
	endpoint: string,
	model: string,
	token?: string,
	tokenLimitField: "max_tokens" | "max_completion_tokens" = "max_tokens",
): EvaluationModel {
	const url = new URL(endpoint);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	) {
		throw new Error("評価用の HTTP(S) URL を指定してください");
	}
	if (!model.trim()) throw new Error("モデル名を指定してください");
	if (
		token &&
		url.protocol === "http:" &&
		url.hostname !== "localhost" &&
		url.hostname !== "[::1]" &&
		!/^127(?:\.\d{1,3}){3}$/.test(url.hostname)
	) {
		throw new Error(
			"認証付きの接続には HTTPS またはループバックを指定してください",
		);
	}
	return {
		async complete(request, signal) {
			const response = await fetch(url, {
				method: "POST",
				signal,
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({
					model,
					stream: false,
					[tokenLimitField]: request.maxOutputTokens,
					messages: [
						{ role: "system", content: request.system },
						{ role: "user", content: request.prompt },
					],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "eumenes_quick_review",
							strict: true,
							schema: request.outputSchema,
						},
					},
				}),
			}).catch((error: unknown) => {
				if (signal.aborted) throw error;
				throw new ModelError("unavailable");
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel().catch(() => {});
				const { status } = response;
				if (status === 401 || status === 403) throw new ModelError("auth");
				if (status === 429) throw new ModelError("rate_limited");
				if (status === 408 || status >= 500)
					throw new ModelError("unavailable");
				throw new ModelError("invalid_response");
			}
			let raw: unknown;
			try {
				raw = JSON.parse(await readText(response.body, 1024 * 1024));
			} catch (error) {
				if (signal.aborted) throw error;
				throw new ModelError("invalid_response");
			}
			const parsed = responseSchema.safeParse(raw);
			if (!parsed.success) throw new ModelError("invalid_response");
			const result = parsed.data;
			const { finish_reason, message } = result.choices[0]!;
			if (finish_reason === "length") throw new ModelError("truncated");
			if (finish_reason === "content_filter" || message.refusal)
				throw new ModelError("refused");
			if (finish_reason !== "stop" || typeof message.content !== "string")
				throw new ModelError("invalid_response");
			return {
				text: message.content,
				model: result.model ?? model,
				usage: result.usage
					? {
							inputTokens: result.usage.prompt_tokens,
							outputTokens: result.usage.completion_tokens,
						}
					: undefined,
			};
		},
	};
}
