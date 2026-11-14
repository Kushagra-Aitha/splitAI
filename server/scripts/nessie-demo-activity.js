// Creates a little real sandbox activity on the mapped demo accounts so sync
// has something to read: purchases, a deposit and a transfer. Skips anything
// that already exists (same kind, amount and description), so rerunning is
// safe. Sandbox only; no real money.
import { optionalEnv } from '../lib/env.js';
import { nessie } from '../lib/nessie.js';

const ACCOUNTS = Object.fromEntries(
  ['MAYA', 'SAM', 'PRIYA', 'ALEX'].map((k) => [k, optionalEnv(`NESSIE_ACCOUNT_ID_${k}`)]),
);
for (const [k, v] of Object.entries(ACCOUNTS)) {
  if (!v) throw new Error(`NESSIE_ACCOUNT_ID_${k} is not set. Run npm run nessie:smoke -- --provision first.`);
}

const MERCHANTS = [
  { name: 'Campus Café', category: 'Food & drink' },
  { name: 'Antonio’s', category: 'Food & drink' },
  { name: 'Trader Joe’s', category: 'Groceries' },
  { name: 'PVTA Transit', category: 'Getting around' },
];

const ACTIVITY = [
  { who: 'MAYA', kind: 'purchase', merchant: 'Campus Café', cents: 450, description: 'Campus Café' },
  { who: 'MAYA', kind: 'purchase', merchant: 'Antonio’s', cents: 4200, description: 'Antonio’s' },
  { who: 'MAYA', kind: 'purchase', merchant: 'PVTA Transit', cents: 300, description: 'PVTA Transit' },
  { who: 'MAYA', kind: 'deposit', cents: 12000, description: 'Campus job' },
  { who: 'PRIYA', kind: 'purchase', merchant: 'Trader Joe’s', cents: 3650, description: 'Trader Joe’s' },
  { who: 'SAM', kind: 'transfer', to: 'MAYA', cents: 500, description: 'Coffee money' },
];

async function merchantIds() {
  const { data } = await nessie('/merchants?limit=100');
  const byName = new Map((data.items ?? []).map((m) => [m.name, m.id]));
  for (const m of MERCHANTS) {
    if (byName.has(m.name)) continue;
    const { data: created } = await nessie('/merchants', { method: 'POST', body: m });
    byName.set(m.name, created.id);
    console.log(`  merchant created  ${m.name}`);
  }
  return byName;
}

async function main() {
  const merchants = await merchantIds();
  const existing = new Map();
  for (const [k, id] of Object.entries(ACCOUNTS)) {
    const { data } = await nessie(`/accounts/${id}/transactions?limit=500`);
    existing.set(k, data.items ?? []);
  }
  for (const a of ACTIVITY) {
    const account = ACCOUNTS[a.who];
    const dupe = existing
      .get(a.who)
      .some((t) => t.kind === a.kind && t.amount_cents === a.cents && t.description === a.description && t.payer_id === account);
    if (dupe) {
      console.log(`  exists   ${a.who.padEnd(6)} ${a.kind.padEnd(9)} ${a.description}`);
      continue;
    }
    const body = { amount_cents: a.cents, description: a.description };
    if (a.kind === 'purchase') body.merchant_id = merchants.get(a.merchant);
    if (a.kind === 'transfer') body.payee_id = ACCOUNTS[a.to];
    const { data } = await nessie(`/accounts/${account}/${a.kind}s`, { method: 'POST', body });
    console.log(`  created  ${a.who.padEnd(6)} ${a.kind.padEnd(9)} ${a.description}  ${data.id} (${data.status})`);
  }
}

main().catch((err) => {
  console.error('Demo activity failed:', err.message);
  process.exitCode = 1;
});
