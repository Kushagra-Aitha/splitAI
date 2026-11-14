import assert from 'node:assert/strict';
import '../lib/env.js';
import { createGeminiClient } from '../assistant/gemini-json.js';
import { answerStatements, createFactExplainer } from '../assistant/answers.js';

// Fixed synthetic aggregates only: no accounts, identity, transactions, or DB.
const facts = { spending: { range: { from: '2026-11-01', to: '2026-11-14', timeZone: 'America/New_York' },
  totals: { spentCents: 4200, earnedCents: 10000 } } };
try {
  const explain = createFactExplainer({ generate: createGeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }) });
  const answer = await explain(answerStatements('spending_insight', facts));
  for (const expected of ['2026-11-01 through 2026-11-14', '$42.00', '$100.00', '$58.00']) assert.ok(answer.includes(expected));
  console.log('Live Gemini insight: exact synthetic figures and data window passed.');
} catch (error) {
  console.error(`Insight smoke failed: ${error.code || 'CHECK_FAILED'}`);
  process.exitCode = 1;
}
