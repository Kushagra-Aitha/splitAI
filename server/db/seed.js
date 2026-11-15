import { optionalEnv } from '../lib/env.js';
import { isMain } from '../lib/is-main.js';
import { hashPassword, PASSWORD_MIN_CHARS } from '../auth/password.js';
import { ACCOUNTS, BILLS, DEMO_EMAILS, GROUPS, USERS } from './demo-ids.js';
import { insertDemoHistory } from './demo-history.js';
import { closePool, dbSchema, getPool, withTransaction } from './pool.js';

const users = [
  { key: 'maya', display: 'Maya', fullName: 'Maya Chen', initials: 'MC', tone: 'citron', mask: '0421' },
  { key: 'sam', display: 'Sam', initials: 'SL', tone: null, mask: null },
  { key: 'priya', display: 'Priya', initials: 'PS', tone: 'pink', mask: null },
  { key: 'alex', display: 'Alex', fullName: 'Alex Rivera', initials: 'AR', tone: 'orange', mask: null },
];

const groups = [
  {
    id: GROUPS.puffton4,
    kind: 'roommates',
    name: 'Puffton 4',
    tagline: 'Home, sweet shared home',
    startsOn: null,
    endsOn: null,
    members: ['maya', 'sam', 'priya', 'alex'],
  },
  {
    id: GROUPS.bostonWeekend,
    kind: 'trip',
    name: 'Boston weekend',
    tagline: 'Nov 20–22',
    startsOn: '2026-11-20',
    endsOn: '2026-11-22',
    members: ['maya', 'sam', 'priya'],
  },
];

// Maya's recurring costs, matching the Profile scaffold. Labeled demo data.
const bills = [
  { id: BILLS.rent, name: 'Rent', cents: 80000, due: '2026-11-14', method: 'Bank transfer', icon: 'house', note: 'Puffton 4 · your share', estimate: false, group: GROUPS.puffton4 },
  { id: BILLS.utilities, name: 'Utilities', cents: 6000, due: '2026-11-14', method: 'Bank transfer', icon: 'plug', note: 'Puffton 4 · estimated share', estimate: true, group: GROUPS.puffton4 },
  { id: BILLS.spotify, name: 'Spotify Student', cents: 1199, due: '2026-11-18', method: 'Card · 0421', icon: 'music-2', note: 'Monthly subscription', estimate: false },
  { id: BILLS.cloudStorage, name: 'Cloud storage', cents: 299, due: '2026-11-21', method: 'Card · 0421', icon: 'cloud', note: 'Monthly subscription', estimate: false },
  { id: BILLS.campusGym, name: 'Campus gym', cents: 2500, due: '2026-11-25', method: 'Card · 0421', icon: 'dumbbell', note: 'Monthly membership', estimate: false },
  { id: BILLS.phonePlan, name: 'Phone plan', cents: 4000, due: '2026-11-28', method: 'Card · 0421', icon: 'smartphone', note: 'Monthly plan', estimate: false },
];

/**
 * Upserts the stable demo rows. Running it again updates the same rows and
 * never duplicates them. Nessie account IDs come from NESSIE_ACCOUNT_ID_<NAME>;
 * an unset variable keeps whatever mapping is already stored.
 */
export async function seed({ log = console.log } = {}) {
  const schema = dbSchema();
  const { rows } = await getPool().query(
    `SELECT to_regclass(format('%I.schema_migrations', $1::text)) IS NOT NULL AS ready`,
    [schema],
  );
  if (!rows[0].ready) throw new Error(`Schema "${schema}" is not migrated. Run npm run db:migrate first.`);

  // Demo logins (B8): every demo user signs in with DEMO_PASSWORD. Unset keeps
  // any password already stored, so re-seeding never locks people out.
  const demoPassword = optionalEnv('DEMO_PASSWORD');
  if (demoPassword && [...demoPassword].length < PASSWORD_MIN_CHARS) {
    throw new Error(`DEMO_PASSWORD must have at least ${PASSWORD_MIN_CHARS} characters.`);
  }
  const hashes = {};
  for (const u of users) hashes[u.key] = demoPassword ? await hashPassword(demoPassword) : null;

  await withTransaction(async (db) => {
    for (const u of users) {
      await db.query(
        `INSERT INTO users (id, handle, display_name, full_name, initials, avatar_tone, email, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           handle = EXCLUDED.handle, display_name = EXCLUDED.display_name,
           full_name = EXCLUDED.full_name, initials = EXCLUDED.initials,
           avatar_tone = EXCLUDED.avatar_tone, email = EXCLUDED.email,
           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)`,
        [USERS[u.key], u.key, u.display, u.fullName ?? null, u.initials, u.tone, DEMO_EMAILS[u.key], hashes[u.key]],
      );
      await db.query(
        `INSERT INTO bank_accounts (id, user_id, provider, nickname, account_type, account_mask)
         VALUES ($1, $2, 'nessie', $3, 'Checking', $4)
         ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id, nickname = EXCLUDED.nickname,
           account_mask = COALESCE(EXCLUDED.account_mask, bank_accounts.account_mask),
           updated_at = now()`,
        [ACCOUNTS[u.key], USERS[u.key], `${u.display}’s demo account`, u.mask],
      );
    }

    // Map configured Nessie accounts. Clear a provider ID from any other row
    // first, so remapping (e.g. swapping two users) never trips the unique key.
    const mapped = [];
    for (const u of users) {
      const providerId = optionalEnv(`NESSIE_ACCOUNT_ID_${u.key.toUpperCase()}`);
      if (!providerId) continue;
      await db.query(
        `UPDATE bank_accounts SET provider_account_id = NULL, updated_at = now()
         WHERE provider_account_id = $1 AND id <> $2`,
        [providerId, ACCOUNTS[u.key]],
      );
      await db.query(
        // Demo checking accounts come pre-linked; their card is opened on Connect (B12).
        `UPDATE bank_accounts SET provider_account_id = $1, linked_at = COALESCE(linked_at, now()), updated_at = now() WHERE id = $2`,
        [providerId, ACCOUNTS[u.key]],
      );
      mapped.push(`${u.display}→${providerId}`);
    }

    for (const g of groups) {
      await db.query(
        `INSERT INTO groups (id, kind, name, tagline, starts_on, ends_on, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind, name = EXCLUDED.name, tagline = EXCLUDED.tagline,
           starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on`,
        [g.id, g.kind, g.name, g.tagline, g.startsOn, g.endsOn, USERS.maya],
      );
      for (const m of g.members) {
        await db.query(
          `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [g.id, USERS[m]],
        );
      }
    }

    for (const b of bills) {
      await db.query(
        `INSERT INTO bill_schedules
           (id, user_id, account_id, group_id, name, amount_cents, is_estimate, recurrence,
            day_of_month, next_due_on, payment_method, icon, note, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'monthly', extract(day FROM $8::date), $8, $9, $10, $11, 'demo')
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, amount_cents = EXCLUDED.amount_cents,
           is_estimate = EXCLUDED.is_estimate, day_of_month = EXCLUDED.day_of_month,
           next_due_on = EXCLUDED.next_due_on, payment_method = EXCLUDED.payment_method,
           icon = EXCLUDED.icon, note = EXCLUDED.note, group_id = EXCLUDED.group_id,
           updated_at = now()`,
        [b.id, USERS.maya, ACCOUNTS.maya, b.group ?? null, b.name, b.cents, b.estimate, b.due, b.method, b.icon, b.note],
      );
    }

    // Labeled Jun 1 – Nov 13 history for Maya (source = 'demo'); see demo-history.js.
    const history = await insertDemoHistory(db, ACCOUNTS.maya);

    log(`Seeded schema "${schema}": ${users.length} users, ${users.length} accounts, ${groups.length} groups, ${bills.length} bills, ${history} new demo history rows.`);
    log(mapped.length ? `  Nessie mapping: ${mapped.join(', ')}` : '  Nessie mapping: none set (NESSIE_ACCOUNT_ID_* empty)');
    log(demoPassword
      ? `  Demo logins: ${Object.values(DEMO_EMAILS).join(', ')} (password from DEMO_PASSWORD)`
      : '  Demo logins: DEMO_PASSWORD not set; existing demo passwords kept');
  });
}

if (isMain(import.meta.url)) {
  seed()
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
