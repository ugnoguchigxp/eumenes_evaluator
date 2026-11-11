import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { previewScope } from "../evaluate";
import { fingerprint } from "../snapshot";

export async function openSteeringConsole(
	scope: ReturnType<typeof previewScope>,
) {
	const resolveFromProject = createRequire(join(process.cwd(), "package.json"));
	let entry: string;
	try {
		entry = resolveFromProject.resolve("eumenes-steer");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND")
			throw error;
		throw new Error(
			"--steer には実行元のプロジェクトに eumenes-steer が必要です",
		);
	}
	const { createSteeringInbox } = (await import(
		entry
	)) as typeof import("eumenes-steer");
	const inbox = createSteeringInbox();
	const runId = crypto.randomUUID();
	const generation = "1";
	const opened = inbox.open(runId, generation);
	if (opened.status !== "opened")
		throw new Error("Steer を開始できませんでした");
	const sources = new Map(
		scope.availableEvidence.map(({ id, version }) => [id, version]),
	);
	const lines = createInterface({ input: process.stdin, terminal: false });
	lines.on("line", (line) => {
		const sourceRef = line.trim();
		if (!sourceRef) return;
		const sourceRevision = sources.get(sourceRef);
		if (!sourceRevision) {
			console.error(`Steer not_allowed ${JSON.stringify(sourceRef)}`);
			return;
		}
		const event = {
			id: fingerprint([sourceRef, sourceRevision]),
			sourceRef,
			sourceRevision,
		};
		const result = inbox.enqueue(runId, generation, event);
		console.error(`Steer ${result.status} ${JSON.stringify(sourceRef)}`);
	});
	lines.on("error", () => {
		console.error("Steer の標準入力を読み取れませんでした");
		lines.close();
	});
	console.error(`Steer ready ${JSON.stringify([...sources.keys()])}`);
	return {
		target: opened.target,
		close() {
			lines.close();
			const unhanded = opened.target.close();
			if (unhanded) console.error(`Steer undelivered ${unhanded}`);
		},
	};
}
