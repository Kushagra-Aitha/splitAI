import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { examples } from './examples.js';
import { normalize, score, tokens } from './classifier.js';

const data = await readFile(new URL('./.cache/SMSSpamCollection', import.meta.url), 'utf8').catch(() => {
  throw new Error('Run npm run guard:train first to fetch the verified public corpus.');
});
const partitions = { train: [], validation: [], test: [] }, seen = new Set();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
for (const line of data.split(/\r?\n/u)) {
  const tab = line.indexOf('\t'); if (tab < 0) continue;
  const label = line.slice(0, tab), text = line.slice(tab + 1, tab + 501), canonical = normalize(text);
  if (!['ham', 'spam'].includes(label) || seen.has(canonical)) continue;
  seen.add(canonical);
  const bucket = createHash('sha256').update(canonical).digest().readUInt32BE() % 100;
  partitions[bucket < 60 ? 'train' : bucket < 80 ? 'validation' : 'test'].push({ label, text, source: 'sms' });
}
for (const [partition, labels] of Object.entries(examples)) for (const [label, values] of Object.entries(labels)) {
  for (const text of values) partitions[partition].push({ label, text, source: 'split' });
}
const assigned = new Map();
for (const [partition, rows] of Object.entries(partitions)) for (const row of rows) {
  const canonical = normalize(row.text), prior = assigned.get(canonical);
  if (prior && prior !== partition) throw new Error('A normalized example appears in multiple partitions.');
  assigned.set(canonical, partition);
}

function train(rows) {
  const documents = new Map(), totals = [0, 0], classes = [0, 0];
  for (const row of rows) {
    const type = row.label === 'spam' ? 1 : 0, weight = row.source === 'split' ? 4 : 1;
    classes[type] += weight;
    for (const token of tokens(row.text)) {
      const counts = documents.get(token) || [0, 0]; counts[type] += weight; documents.set(token, counts);
    }
  }
  const vocabulary = [...documents].filter(([, counts]) => counts[0] + counts[1] >= 2)
    .sort((a, b) => b[1][0] + b[1][1] - a[1][0] - a[1][1] || compare(a[0], b[0])).slice(0, 6000);
  for (const [, counts] of vocabulary) { totals[0] += counts[0]; totals[1] += counts[1]; }
  const weights = Object.fromEntries(vocabulary.sort(([a], [b]) => compare(a, b)).map(([token, counts]) => [token,
    counts.map((count, i) => Number(Math.log((count + 1) / (totals[i] + vocabulary.length)).toFixed(10)))]));
  return { version: 'split-guard-nb-v1', algorithm: 'multinomial-naive-bayes-binary-features', threshold: .99,
    priors: classes.map((count) => Math.log(count / (classes[0] + classes[1]))), weights };
}
function evaluate(rows, model) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const row of rows) {
    const result = score(row.text, model).flagged;
    if (result && row.label === 'spam') tp++; else if (result) fp++; else if (row.label === 'spam') fn++; else tn++;
  }
  return { samples: rows.length, truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn,
    precision: tp + fp ? tp / (tp + fp) : 0, recall: tp + fn ? tp / (tp + fn) : 0 };
}

let model;
if (process.argv.includes('--eval')) {
  model = JSON.parse(await readFile(new URL('./model.json', import.meta.url), 'utf8'));
  if (model.corpusSha256 !== createHash('sha256').update(data).digest('hex')) throw new Error('Evaluation corpus does not match the model.');
}
else {
  model = train(partitions.train);
  const candidates = [.8, .9, .95, .98, .99, .995, .999, .9999].map((threshold) => ({ threshold,
    domainPrecision: evaluate(partitions.validation.filter((row) => row.source === 'split'), { ...model, threshold }).precision,
    ...evaluate(partitions.validation, { ...model, threshold }) }))
    .filter((result) => result.precision >= .97 && result.domainPrecision >= .97 && result.truePositive >= 10)
    // Warnings should favor precision; choose on validation data only.
    .sort((a, b) => b.precision - a.precision || b.recall - a.recall);
  if (!candidates.length) throw new Error('No validation threshold meets the precision floor. Review training without tuning on the held-out test set.');
  model.threshold = candidates[0].threshold;
  model.corpusSha256 = createHash('sha256').update(data).digest('hex');
  model.revision = `${model.version}:${createHash('sha256').update(JSON.stringify({ weights: model.weights,
    priors: model.priors, threshold: model.threshold, corpus: model.corpusSha256, examples })).digest('hex').slice(0, 12)}`;
  model.split = 'SHA256(normalized text) mod 100: train <60, validation <80, test otherwise; deduplicated before splitting';
  await writeFile(new URL('./model.json', import.meta.url), `${JSON.stringify(model)}\n`);
}
const report = { modelVersion: model.version, modelRevision: model.revision, corpusSha256: model.corpusSha256, threshold: model.threshold, trainingSamples: partitions.train.length,
  validation: evaluate(partitions.validation, model), heldOut: evaluate(partitions.test, model),
  splitValidation: evaluate(partitions.validation.filter((row) => row.source === 'split'), model),
  splitHeldOut: evaluate(partitions.test.filter((row) => row.source === 'split'), model),
  publicSmsHeldOut: evaluate(partitions.test.filter((row) => row.source === 'sms'), model) };
console.log(JSON.stringify(report, null, 2));
if (report.heldOut.precision < .95 || report.heldOut.truePositive < 10 || report.splitHeldOut.precision < .95) process.exitCode = 1;
