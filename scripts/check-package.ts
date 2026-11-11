import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devDependencies, name, version } from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "eumenes-evaluator-pack-"));
const consumer = join(temp, "consumer");
const bun = process.execPath;

function run(cwd: string, args: string[], expected = 0) {
	const result = Bun.spawnSync({ cwd, cmd: [bun, ...args] });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	assert.equal(
		result.exitCode,
		expected,
		`${args.join(" ")}\n${stdout}${stderr}`,
	);
	return { stdout, stderr };
}

try {
	run(root, ["pm", "pack", "--destination", temp, "--ignore-scripts"]);
	await mkdir(consumer);
	await Bun.write(join(consumer, "package.json"), '{"private":true}');
	run(consumer, [
		"add",
		join(temp, `${name}-${version}.tgz`),
		"--ignore-scripts",
	]);
	assert.equal(
		await Bun.file(
			join(consumer, "node_modules/eumenes-steer/package.json"),
		).exists(),
		false,
	);

	const packageDir = join(consumer, "node_modules", name);
	assert.equal(
		await Bun.file(
			join(packageDir, devDependencies["eumenes-steer"].slice(5)),
		).exists(),
		false,
	);
	await Bun.write(
		join(consumer, "smoke.ts"),
		`import assert from "node:assert/strict";
import { comparisonRequest, evaluate, requestSchema } from "${name}";
const fixtures = "node_modules/${name}/examples/";
const input = requestSchema.parse(await Bun.file(fixtures + "code-request.json").json());
const text = await Bun.file(fixtures + "code-response.json").text();
const result = await evaluate(comparisonRequest(input, "C"), {
  model: { async complete() { return { text }; } },
});
assert.equal(result.status, "completed");
assert.equal(result.findings.length, 1);
`,
	);
	run(consumer, ["smoke.ts"]);

	const request = join(packageDir, "examples/cases/retry-delay.json");
	const selection = join(packageDir, "examples/scopes/retry-line.json");
	const cli = join(packageDir, "src/cli.ts");
	const args = [cli, request, "--scope", selection];
	const preview = JSON.parse(run(consumer, [...args, "--preview"]).stdout);
	const plan = join(consumer, "investigation.json");
	const output = join(consumer, "verification.json");
	await Bun.write(plan, '{"hypotheses":[],"openQuestions":[],"requests":[]}');
	await Bun.write(
		output,
		JSON.stringify({
			findings: [],
			scopeChecks: [
				...preview.selected.map(({ id }: { id: string }) => id),
				...preview.requiredEvidenceIds,
			].map((evidenceId) => ({ evidenceId, status: "checked", reason: null })),
			conditionChecks: [],
			questionChecks: [],
		}),
	);
	const steer = [
		...args,
		"--expected-scope-digest",
		preview.digest,
		"--depth",
		"standard",
		"--steer",
		"--fixture",
		plan,
		"--fixture",
		output,
	];
	assert.match(run(consumer, steer, 1).stderr, /--steer.*eumenes-steer/);
	run(consumer, [
		"add",
		join(root, devDependencies["eumenes-steer"].slice(5)),
		"--ignore-scripts",
	]);
	assert.match(run(consumer, steer).stderr, /Steer ready/);
	console.log("Pack install, evaluation, and optional Steer passed");
} finally {
	await rm(temp, { recursive: true, force: true });
}
