// Nessie v2 sandbox smoke check.
//
//   npm run nessie:smoke                  read-only: health, key, accounts, mapped accounts
//   npm run nessie:smoke -- --seed        also POST /data/seed (Nessie's own sample data)
//   npm run nessie:smoke -- --provision   create one Checking account per demo user
//                                          (skips any that already exist) and print the
//                                          NESSIE_ACCOUNT_ID_* lines for server/.env
//
// Never moves money.
import { optionalEnv } from '../lib/env.js';
import { nessie } from '../lib/nessie.js';

const args = new Set(process.argv.slice(2));
const dollars = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);

const DEMO = [
  { key: 'MAYA', first: 'Maya', last: 'Demo', balance: 124800 },
  { key: 'SAM', first: 'Sam', last: 'Demo', balance: 95000 },
  { key: 'PRIYA', first: 'Priya', last: 'Demo', balance: 110000 },
  { key: 'ALEX', first: 'Alex', last: 'Rivera', balance: 87500 },
];
const nickname = (d) => `Split demo · ${d.first}`;
const ADDRESS = { street_number: '1', street_name: 'Puffton Village', city: 'Amherst', state: 'MA', zip: '01002' };

async function listAccounts() {
  const items = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const { data } = await nessie(`/accounts?${q}`);
    items.push(...(data.items ?? []));
    cursor = data.next_cursor || null;
  } while (cursor && items.length < 500);
  return items;
}

async function provision(accounts) {
  console.log('\nProvisioning demo accounts');
  const lines = [];
  for (const d of DEMO) {
    let acct = accounts.find((a) => a.nickname === nickname(d));
    if (acct) {
      console.log(`  exists   ${nickname(d)}  ${acct.id}`);
    } else {
      const { data: customer } = await nessie('/customers', {
        method: 'POST',
        body: { first_name: d.first, last_name: d.last, address: ADDRESS },
      });
      ({ data: acct } = await nessie(`/customers/${customer.id}/accounts`, {
        method: 'POST',
        body: { type: 'Checking', nickname: nickname(d), balance_cents: d.balance },
      }));
      console.log(`  created  ${nickname(d)}  ${acct.id}  ${dollars(acct.balance_cents)}`);
    }
    lines.push(`NESSIE_ACCOUNT_ID_${d.key}=${acct.id}`);
  }
  console.log('\nPaste into server/.env:\n' + lines.join('\n'));
}

async function main() {
  console.log(`Nessie: ${optionalEnv('NESSIE_URL')}`);

  const health = await nessie('/health', { auth: false });
  console.log(`  health      ${health.status} ${JSON.stringify(health.data)}`);

  const customers = await nessie('/customers?limit=100');
  console.log(`  api key     OK (${customers.data.items?.length ?? 0} customers visible)`);

  if (args.has('--seed')) {
    const { data } = await nessie('/data/seed', { method: 'POST' });
    console.log(`  seeded      ${JSON.stringify(data)}`);
  }

  let accounts = await listAccounts();
  console.log(`\nAccounts on this key: ${accounts.length}`);
  for (const a of accounts) {
    console.log(`  ${a.id}  ${String(a.type).padEnd(11)} ${String(a.nickname).padEnd(26)} balance ${dollars(a.balance_cents)}  available ${dollars(a.available_cents)}`);
  }

  if (args.has('--provision')) {
    await provision(accounts);
    accounts = await listAccounts();
  }

  console.log('\nMapped demo accounts (NESSIE_ACCOUNT_ID_*)');
  let mappedCount = 0;
  let rate = null;
  for (const d of DEMO) {
    const id = optionalEnv(`NESSIE_ACCOUNT_ID_${d.key}`);
    if (!id) {
      console.log(`  ${d.key.padEnd(6)} not set`);
      continue;
    }
    const { data: acct } = await nessie(`/accounts/${encodeURIComponent(id)}`);
    const tx = await nessie(`/accounts/${encodeURIComponent(id)}/transactions?limit=100`);
    rate = tx.rateRemaining;
    const kinds = {};
    for (const t of tx.data.items ?? []) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
    const kindText = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'no activity yet';
    console.log(`  ${d.key.padEnd(6)} ${id}  balance ${dollars(acct.balance_cents)}  · ${kindText}`);
    mappedCount++;
  }
  if (rate !== null) console.log(`\nRate limit remaining: ${rate}`);
  console.log(`\nNessie smoke check: OK${mappedCount < DEMO.length ? ` (${DEMO.length - mappedCount} demo user(s) unmapped)` : ''}`);
}

main().catch((err) => {
  console.error('\nNessie smoke check failed:', err.message);
  if (err.status === 401) console.error('  Check NESSIE_API_KEY (Bearer nsk_...).');
  process.exitCode = 1;
});
