import { z } from "zod";
import type { EvaluationModel } from "./contracts";
import { readText } from "./read-text";

export const openaiLuna = "gpt-6-luna";

export function openaiLunaModel(): EvaluationModel {
	const key = Bun.env.OPEN_AI_API_KEY?.trim();
	if (!key) throw new Error("OPEN_AI_API_KEY を設定してください");
	return httpModel(
		"https://api.openai.com/v1/chat/completions",
		openaiLuna,
		key,
		"max_completion_tokens",
	);
}

const responseSchema = z.object({
	model: z.string().max(256).optional(),
	choices: z
		.array(
			z.object({
				finish_reason: z.literal("stop"),
				message: z.object({ content: z.string() }),
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
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new Error("構造化推論に失敗しました");
			}
			const result = responseSchema.parse(
				JSON.parse(await readText(response.body, 1024 * 1024)),
			);
			return {
				text: result.choices[0]!.message.content,
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
