// Sync every mapped demo account from Nessie into bank_transactions.
//
//   npm run banking:sync              sync once and print counts
//   npm run banking:sync -- --verify  B2 acceptance: sync twice and prove the
//                                     second sync adds no rows or chart dollars
import { syncAll } from '../banking/sync.js';
import { closePool, getPool } from '../db/pool.js';

const dollars = (c) => `$${(Number(c) / 100).toFixed(2)}`;

async function snapshot(db) {
  const { rows } = await db.query(
    `SELECT a.id, u.display_name AS name,
            count(t.id)::int AS rows,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.direction = 'debit'), 0)::bigint AS debits,
            coalesce(sum(t.amount_cents) FILTER (WHERE t.direction = 'credit'), 0)::bigint AS credits,
            (SELECT count(*)::int FROM bank_import_keys k WHERE k.account_id = a.id) AS keys
       FROM bank_accounts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN bank_transactions t ON t.account_id = a.id
      GROUP BY a.id, u.display_name, u.handle
      ORDER BY u.handle`,
  );
  return rows;
}

function print(results) {
  for (const r of results) {
    console.log(
      `  ${r.displayName.padEnd(6)} +${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged` +
        `${r.skipped ? `, ${r.skipped} skipped` : ''} · balance ${dollars(r.balanceCents)}`,
    );
  }
}

const db = getPool();
try {
  if (!process.argv.includes('--verify')) {
    console.log('Syncing mapped accounts');
    print(await syncAll(db));
  } else {
    console.log('Sync 1');
    print(await syncAll(db));
    const first = await snapshot(db);
    console.log('Sync 2');
    print(await syncAll(db));
    const second = await snapshot(db);

    let ok = true;
    console.log('\nAccount  rows  keys  debits      credits');
    for (const s of second) {
      const f = first.find((x) => x.id === s.id);
      const same = f.rows === s.rows && f.debits === s.debits && f.credits === s.credits;
      const keyed = s.rows === s.keys;
      ok &&= same && keyed;
      console.log(
        `${s.name.padEnd(8)} ${String(s.rows).padStart(4)}  ${String(s.keys).padStart(4)}  ${dollars(s.debits).padStart(10)}  ${dollars(s.credits).padStart(10)}` +
          `  ${same ? 'unchanged by sync 2' : 'CHANGED by sync 2'}${keyed ? '' : ', rows ≠ import keys'}`,
      );
    }
    console.log(ok ? '\nB2 check: OK, syncing twice created no extra rows or chart dollars' : '\nB2 check: FAILED');
    if (!ok) process.exitCode = 1;
  }
} catch (err) {
  console.error('Sync failed:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
