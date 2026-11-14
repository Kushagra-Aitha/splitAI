// B1 acceptance: for every mapped demo user, compare what the app normalizes
// against the raw Nessie response. Read-only.
import { listMappedAccounts, readAccountActivity, readMerchants } from '../banking/provider.js';
import { closePool, getPool } from '../db/pool.js';
import { nessie } from '../lib/nessie.js';

const dollars = (c) => `$${(c / 100).toFixed(2)}`;
let mismatches = 0;

try {
  const accounts = await listMappedAccounts(getPool());
  if (!accounts.length) throw new Error('No mapped accounts. Set NESSIE_ACCOUNT_ID_* and run npm run db:seed.');
  const merchants = await readMerchants();

  for (const a of accounts) {
    const { balance, transactions, skipped } = await readAccountActivity(a.providerAccountId, { merchants });
    const { data: raw } = await nessie(`/accounts/${a.providerAccountId}`);
    const { data: rawTx } = await nessie(`/accounts/${a.providerAccountId}/transactions?limit=1000`);

    const balanceOk = balance.balanceCents === raw.balance_cents && balance.availableCents === raw.available_cents;
    const rawIds = (rawTx.items ?? []).map((t) => t.id).sort();
    const ourIds = transactions.map((t) => t.providerTransactionId).sort();
    const activityOk = skipped === 0 && JSON.stringify(rawIds) === JSON.stringify(ourIds) &&
      transactions.every((t) => t.amountCents === rawTx.items.find((r) => r.id === t.providerTransactionId).amount_cents);
    if (!balanceOk || !activityOk) mismatches++;

    console.log(`\n${a.displayName}  ${a.providerAccountId}`);
    console.log(`  balance ${dollars(balance.balanceCents)}  available ${dollars(balance.availableCents)}  ${balanceOk ? 'matches' : 'MISMATCH'} provider`);
    console.log(`  activity ${transactions.length} normalized / ${rawIds.length} from provider  ${activityOk ? 'matches' : 'MISMATCH'}`);
    for (const t of transactions) {
      const sign = t.direction === 'credit' ? '+' : '−';
      console.log(`    ${t.occurredAt.slice(0, 19)}  ${t.kind.padEnd(9)} ${t.status.padEnd(9)} ${sign}${dollars(t.amountCents).padStart(9)}  ${t.description}`);
    }
  }
  console.log(mismatches ? `\nB1 check: ${mismatches} account(s) MISMATCH` : '\nB1 check: OK, balance and activity match the provider');
  if (mismatches) process.exitCode = 1;
} catch (err) {
  console.error('B1 check failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
