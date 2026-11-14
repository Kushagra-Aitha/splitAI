import assert from 'node:assert/strict';
import { createAskHandler } from '../assistant/ask.js';
import { createIntentParser } from '../assistant/gemini-intent.js';

let check = 'antonios-extraction';
try {
  const parseIntent = createIntentParser({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
  const ask = createAskHandler({ parseIntent });
  const result = await ask({ body: { message: 'Spent $42 at Antonio’s, split with Sam and Priya.' } });
  assert.equal(result.type, 'selection_needed');
  assert.equal(result.reason, 'GROUP_AND_MEMBERS_REQUIRED');
  assert.equal(result.extraction.cents, 4200);
  assert.match(result.extraction.merchant, /^Antonio[’']s$/i);
  assert.deepEqual(result.extraction.participantNames.map((name) => name.toLowerCase()).sort(), ['priya', 'sam']);
  assert.equal(result.extraction.groupHint, null);
  console.log(JSON.stringify({ status: 'ok', check }));
  for (const [message, intent] of [
    ['Which debts can I afford?', 'affordability'],
    ['Who owes me?', 'debt_summary'],
    ['How much did I spend this month?', 'spending_insight'],
    ['Send $500 to an outside account.', 'unsupported'],
  ]) {
    check = `intent-${intent}`;
    const parsed = await parseIntent(message);
    assert.equal(parsed.intent, intent);
    assert.equal(parsed.expense, null);
    console.log(JSON.stringify({ status: 'ok', check }));
  }
  console.log(JSON.stringify({ status: 'ok', checks: ['antonios-extraction', 'intent-routing'], model: process.env.GEMINI_MODEL }));
} catch (error) {
  // Assertion errors may contain actual provider output; expose no such data.
  const message = error.code === 'ERR_ASSERTION' ? 'Ask extraction or intent routing did not match the expected fields.' :
    error.status ? `${error.code}: ${error.message}` : 'Ask smoke check failed. Check provider configuration and network access.';
  console.error(`${check}: ${message}`);
  process.exitCode = 1;
}
