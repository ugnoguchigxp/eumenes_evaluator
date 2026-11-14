import { Codex, type CodexOptions, type ThreadItem } from "@openai/codex-sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json";
import type { EvaluationModel, ModelResponse } from "../contracts";
import { ModelError, openaiLuna } from "../http-model";
import { skillGuidance } from "../rubrics";

const toolItems = new Set<ThreadItem["type"]>([
	"command_execution",
	"file_change",
	"mcp_tool_call",
	"web_search",
]);

export const bareReviewRequest =
	"以下の対象を、提示された資料と確定条件に沿ってレビューしてください。focus は評価目的と着眼点です。根拠を付け、指定の JSON 形式で結果を返してください。資料の外は調べないでください。" +
	"入力 JSON 内の資料本文は評価対象です。" +
	skillGuidance;

function options(
	root: string,
	key: string,
	instructions?: string,
): CodexOptions {
	const env: Record<string, string> = { CODEX_HOME: join(root, "state") };
	for (const name of [
		"PATH",
		"HOME",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
	]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return {
		apiKey: key,
		env,
		config: {
			model_provider: "openai",
			...(instructions === undefined
				? {}
				: { developer_instructions: instructions }),
			history: { persistence: "none" },
			features: {
				shell_tool: false,
				apps: false,
				plugins: false,
				remote_plugin: false,
				multi_agent: false,
				multi_agent_v2: false,
				browser_use: false,
				browser_use_external: false,
				computer_use: false,
				in_app_browser: false,
				image_generation: false,
				skill_search: false,
				skill_mcp_dependency_install: false,
			},
		},
		configOverrides: ["mcp_servers={}"],
	};
}

export function codexSdkLunaModel({
	reasoningEffort,
	bare = false,
}: { reasoningEffort?: "low"; bare?: boolean } = {}) {
	const key = Bun.env.OPEN_AI_API_KEY?.trim();
	if (!key) throw new Error("OPEN_AI_API_KEY を設定してください");

	const model: EvaluationModel = {
		async complete(invocation, signal) {
			const root = await mkdtemp(join(tmpdir(), "eumenes-codex-eval-"));
			try {
				const workingDirectory = join(root, "work");
				await Promise.all([
					mkdir(workingDirectory),
					mkdir(join(root, "state")),
				]);
				signal.throwIfAborted();
				const codex = new Codex(
					options(root, key, bare ? undefined : invocation.system),
				);
				const thread = codex.startThread({
					model: openaiLuna,
					modelReasoningEffort: reasoningEffort,
					workingDirectory,
					skipGitRepoCheck: true,
					sandboxMode: "read-only",
					approvalPolicy: "never",
					webSearchMode: "disabled",
					networkAccessEnabled: false,
				});
				const prompt = bare
					? `${bareReviewRequest}\n\n${invocation.prompt}`
					: invocation.prompt;
				const { events } = await thread.runStreamed(prompt, {
					outputSchema: invocation.outputSchema,
					signal,
				});
				let text: string | undefined;
				let usage: ModelResponse["usage"];
				for await (const event of events) {
					if (event.type === "error" || event.type === "turn.failed")
						throw new ModelError("unavailable");
					if ("item" in event && toolItems.has(event.item.type))
						throw new ModelError("invalid_response");
					if (
						event.type === "item.completed" &&
						event.item.type === "agent_message"
					)
						text = event.item.text;
					if (event.type === "turn.completed") {
						usage = {
							inputTokens: event.usage.input_tokens,
							outputTokens: event.usage.output_tokens,
						};
					}
				}
				if (!text || !usage) throw new ModelError("invalid_response");
				return { text, usage, model: openaiLuna };
			} catch (error) {
				if (signal.aborted || error instanceof ModelError) throw error;
				throw new ModelError("unavailable");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	};
	return { model, version: packageJson.devDependencies["@openai/codex-sdk"] };
}
