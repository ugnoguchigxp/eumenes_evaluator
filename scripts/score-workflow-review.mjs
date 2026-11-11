import { z } from "zod";

const [goldPath, runsPath, gradesPath] = Bun.argv.slice(2);
if (!goldPath || !runsPath || !gradesPath || Bun.argv.length !== 5)
	throw new Error(
		"usage: bun scripts/score-workflow-review.mjs <gold.json> <runs.jsonl> <basis-grades.json>",
	);

const goldEntry = z.strictObject({
	id: z.string().min(1),
	expected: z.string(),
	violation: z.boolean(),
});
const gold = z
	.record(z.string(), z.record(z.string(), goldEntry))
	.parse(await Bun.file(goldPath).json());
const basisGrade = z.strictObject({
	status: z.enum(["correct", "incorrect", "insufficient"]),
	reason: z.string().min(1),
});
const grades = z
	.record(z.string(), basisGrade)
	.parse(await Bun.file(gradesPath).json());

const lines = (await Bun.file(runsPath).text()).trim().split("\n");
const runs = lines.map((line) => JSON.parse(line));
const seenTrials = new Set();
const usedGrades = new Set();

// Allocation components can be written in any order in the fixture.
function normalize(value) {
	const prefix = "ALLOCATE:";
	return value?.startsWith(prefix)
		? prefix + value.slice(prefix.length).split("+").sort().join("+")
		: value;
}

const totals = {
	trials: runs.length,
	handedOff: 0,
	violations: 0,
	normal: 0,
	detected: 0,
	falsePositives: 0,
	deliveredDetections: 0,
	deliveredValueCorrect: 0,
	deliveredBasisCorrect: 0,
	deliveredBothCorrect: 0,
};

const trials = runs.map((run) => {
	const trialKey = run.case + ":" + run.repetition;
	const expected = Object.hasOwn(gold, run.case) ? gold[run.case] : undefined;
	if (!expected || seenTrials.has(trialKey))
		throw new Error("Unknown or repeated trial " + trialKey);
	seenTrials.add(trialKey);
	for (const row of Object.values(expected)) {
		if (row.violation) totals.violations++;
		else totals.normal++;
	}
	const actual = new Map(
		(run.modelOutput?.rows ?? []).map((row) => [row.pointer, row.basis.value]),
	);
	const flagged = (findings) =>
		[...new Set(findings.map((finding) => finding.primary.pointer))].map(
			(pointer) => {
				if (!Object.hasOwn(expected, pointer))
					throw new Error("Finding points outside the gold rows: " + pointer);
				return { pointer, ...expected[pointer] };
			},
		);
	for (const row of flagged(run.review?.value?.findings ?? [])) {
		if (row.violation) totals.detected++;
		else totals.falsePositives++;
	}
	if (run.handoff != null) totals.handedOff++;
	const handedOff = flagged(run.handoff?.findings ?? []).map((row) => {
		const value = actual.get(row.pointer);
		const valueCorrect = normalize(value) === normalize(row.expected);
		const key = trialKey + ":" + row.id;
		const basis = Object.hasOwn(grades, key) ? grades[key] : undefined;
		if (basis) usedGrades.add(key);
		if (row.violation) {
			if (!basis) throw new Error("Missing basis grade for " + key);
			totals.deliveredDetections++;
			if (valueCorrect) totals.deliveredValueCorrect++;
			if (basis.status === "correct") totals.deliveredBasisCorrect++;
			if (valueCorrect && basis.status === "correct")
				totals.deliveredBothCorrect++;
		}
		return { ...row, value, valueCorrect, basis };
	});
	return { case: run.case, repetition: run.repetition, handedOff };
});

if (Object.keys(grades).some((key) => !usedGrades.has(key)))
	throw new Error("Basis grades include a row that was not handed off");
console.log(JSON.stringify({ totals, trials }, null, "\t"));
