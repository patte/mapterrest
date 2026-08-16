// Coverage parity between the old verify script and the playwright suite: every check
// label from the baseline run must reappear, as a multiset, among the step titles of the
// new suite's JSON report.
//
//   node scripts/coverage-diff.mjs extract <baseline.log>   # manifest to stdout
//   node scripts/coverage-diff.mjs diff [report.json] [manifest.txt]
import { readFileSync } from 'node:fs';

const [mode, a, b] = process.argv.slice(2);

// `ok  ` / `FAIL` prefix, then the label; a detail, when present, follows two spaces.
function labelsFromLog(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => /^(?:ok {2}|FAIL) {2}(.+)$/.exec(l)?.[1])
    .filter(Boolean)
    .map((l) => l.split('  ')[0]);
}

function labelsFromReport(path) {
  const out = [];
  // The JSON reporter emits only test.step-category steps, and without a category field.
  const walkSteps = (steps) => {
    for (const s of steps ?? []) {
      out.push(s.title);
      walkSteps(s.steps);
    }
  };
  const walkSuites = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? [])
        // Retries rerun the same steps; count only the last attempt.
        walkSteps(t.results?.at(-1)?.steps);
    for (const child of suite.suites ?? []) walkSuites(child);
  };
  for (const suite of JSON.parse(readFileSync(path, 'utf8')).suites ?? []) walkSuites(suite);
  return out;
}

const tally = (labels) => {
  const m = new Map();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

if (mode === 'extract') {
  console.log(labelsFromLog(a).join('\n'));
} else if (mode === 'diff') {
  const want = tally(
    readFileSync(b ?? 'tests/coverage-manifest.txt', 'utf8').split('\n').filter(Boolean),
  );
  const have = tally(labelsFromReport(a ?? 'test-results/report.json'));
  let bad = false;
  for (const [label, n] of want) {
    const h = have.get(label) ?? 0;
    if (h < n) (bad = true), console.log(`missing (${h}/${n}): ${label}`);
  }
  for (const [label, n] of have) {
    const w = want.get(label) ?? 0;
    if (n > w) console.log(`extra (${n}/${w}): ${label}`);
  }
  const covered = [...want].reduce((s, [l, n]) => s + Math.min(n, have.get(l) ?? 0), 0);
  const total = [...want.values()].reduce((s, n) => s + n, 0);
  console.log(`\n${covered}/${total} baseline checks covered`);
  process.exit(bad ? 1 : 0);
} else {
  console.error('usage: coverage-diff.mjs extract <log> | diff [report.json] [manifest]');
  process.exit(2);
}
