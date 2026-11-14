import { recordGuardEvent } from '../guard/events.js';
import { getMappedAccountForUser } from '../banking/provider.js';
import { readDebts, readLedger, summarizeDebts } from './debts.js';
import { HttpError } from '../http.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const groupColumns = `g.id, g.kind, g.name, g.tagline,
  g.starts_on::text AS "startsOn", g.ends_on::text AS "endsOn"`;

function invalid(message) {
  return new HttpError(422, 'VALIDATION_ERROR', message);
}

function readIds(ids, field) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !uuid.test(id))) {
    throw invalid(`${field} must contain user IDs.`);
  }
  return ids.map((id) => id.toLowerCase());
}

function optionalText(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid(`${field} must be text.`);
  return value.trim() || null;
}

function readDate(value, field) {
  if (value == null) return null;
  if (typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !value.startsWith('0000')) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw invalid(`${field} must be a valid YYYY-MM-DD date.`);
}

async function requireGroup(db, id, userId) {
  const { rows: [group] } = await db.query(`
    SELECT ${groupColumns}
    FROM groups g JOIN group_members m ON m.group_id = g.id
    WHERE g.id = $1 AND m.user_id = $2
  `, [id, userId]);
  if (!group) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Group not found.');
  return group;
}

async function requirePurchase(db, userId, { accountId, providerKey }, cents) {
  const { rowCount } = await db.query(`
    SELECT t.id
    FROM bank_import_keys k
    JOIN bank_accounts a ON a.id = k.account_id
    JOIN bank_transactions t ON t.account_id = k.account_id
      AND t.id = k.transaction_id AND t.occurred_at = k.occurred_at
    WHERE a.user_id = $1 AND k.account_id = $2 AND k.provider_key = $3
      AND t.kind = 'purchase' AND t.direction = 'debit' AND t.amount_cents = $4
  `, [userId, accountId, providerKey, cents]);
  if (!rowCount) throw invalid('Choose an imported purchase from your account with the same amount.');
}

export function createLedgerHandlers({ query, withTransaction }) {
  return {
    async 'groups.list'({ actor }) {
      const { rows } = await query(`
        SELECT ${groupColumns}, count(m.user_id)::int AS "memberCount"
        FROM group_members mine
        JOIN groups g ON g.id = mine.group_id
        JOIN group_members m ON m.group_id = g.id
        WHERE mine.user_id = $1
        GROUP BY g.id
        ORDER BY g.created_at, g.id
      `, [actor.userId]);
      const debtRows = await readDebts({ query }, rows.map(({ id }) => id), actor.userId);
      return { groups: rows.map((group) => {
        const { youOweCents, owedToYouCents } = summarizeDebts(debtRows.filter(({ groupId }) => groupId === group.id));
        return { ...group, youOweCents, owedToYouCents };
      }) };
    },

    async 'groups.create'({ actor, body }) {
      const { kind } = body;
      if (kind !== 'roommates' && kind !== 'trip') throw invalid('Choose roommates or trip.');
      const name = optionalText(body.name, 'name');
      if (!name) throw invalid('Enter a group name.');
      const tagline = optionalText(body.tagline, 'tagline');
      const startsOn = readDate(body.startsOn, 'startsOn');
      const endsOn = readDate(body.endsOn, 'endsOn');
      if (startsOn && endsOn && endsOn < startsOn) throw invalid('The end date must follow the start date.');
      const memberIds = [...new Set([actor.userId, ...readIds(body.memberIds ?? [], 'memberIds')])];

      return withTransaction(async (db) => {
        const { rowCount } = await db.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [memberIds]);
        if (rowCount !== memberIds.length) throw invalid('Choose existing users as group members.');
        const { rows: [group] } = await db.query(`
          INSERT INTO groups AS g (kind, name, tagline, starts_on, ends_on, created_by)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING ${groupColumns}
        `, [kind, name, tagline, startsOn, endsOn, actor.userId]);
        await db.query(`
          INSERT INTO group_members (group_id, user_id)
          SELECT $1, user_id FROM unnest($2::uuid[]) AS members(user_id)
        `, [group.id, memberIds]);
        return { group };
      });
    },

    async 'expenseDrafts.create'({ actor, body }) {
      const { groupId, cents } = body;
      if (typeof groupId !== 'string' || !uuid.test(groupId)) throw invalid('Choose a valid group.');
      if (!Number.isSafeInteger(cents) || cents < 1) throw invalid('Enter a positive amount in integer cents.');
      const merchant = optionalText(body.merchant, 'merchant');
      if (!merchant) throw invalid('Enter a merchant.');
      const category = optionalText(body.category, 'category');
      const participantIds = readIds(body.participantIds, 'participantIds');
      if (!participantIds.length || new Set(participantIds).size !== participantIds.length) {
        throw invalid('Choose a nonempty list of distinct participants.');
      }
      const bankRef = body.bankRef ?? null;
      if (bankRef !== null && (typeof bankRef.accountId !== 'string' || !uuid.test(bankRef.accountId) ||
          typeof bankRef.providerKey !== 'string' || !bankRef.providerKey.trim())) {
        throw invalid('Choose a valid imported purchase.');
      }

      return withTransaction(async (db) => {
        const group = await requireGroup(db, groupId, actor.userId);
        if (bankRef !== null) await requirePurchase(db, actor.userId, bankRef, cents);
        const { rows: participants } = await db.query(`
          SELECT u.id AS "userId", u.display_name AS "displayName"
          FROM group_members m JOIN users u ON u.id = m.user_id
          WHERE m.group_id = $1 AND u.id = ANY($2::uuid[])
          ORDER BY (u.id = $3) DESC, u.id
        `, [group.id, participantIds, actor.userId]);
        if (participants.length !== participantIds.length) {
          throw invalid('Choose participants who belong to the group.');
        }
        const base = Math.floor(cents / participants.length);
        const remainder = cents % participants.length;
        const shares = participants.map((member, index) => ({
          ...member, cents: base + (index < remainder ? 1 : 0),
        }));
        const { rows: [draft] } = await db.query(`
          INSERT INTO expenses (group_id, created_by, merchant, category, total_cents, expires_at, bank_account_id, bank_provider_key)
          VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes', $6, $7)
          RETURNING id, status, created_at AS "createdAt", expires_at AS "expiresAt"
        `, [group.id, actor.userId, merchant, category, cents, bankRef?.accountId ?? null, bankRef?.providerKey ?? null]);
        await db.query(`
          INSERT INTO expense_shares (expense_id, user_id, share_cents)
          SELECT $1, user_id, share_cents
          FROM unnest($2::uuid[], $3::bigint[]) AS shares(user_id, share_cents)
        `, [draft.id, shares.map((share) => share.userId), shares.map((share) => share.cents)]);
        return {
          draft: {
            ...draft, groupId: group.id, payerUserId: actor.userId, merchant, category,
            totalCents: cents, shares, bankRef,
          },
        };
      });
    },

    async 'expenseDrafts.confirm'({ actor, params }) {
      if (!uuid.test(params.id)) throw invalid('Choose a valid expense draft.');
      try {
        return await withTransaction(async (db) => {
          const { rows: [row] } = await db.query(`
            SELECT e.id, e.group_id AS "groupId", e.status, e.total_cents AS "totalCents",
              e.confirmed_at AS "confirmedAt", e.expires_at <= clock_timestamp() AS expired,
              e.bank_account_id AS "accountId", e.bank_provider_key AS "providerKey"
            FROM expenses e JOIN group_members m ON m.group_id = e.group_id AND m.user_id = e.created_by
            WHERE e.id = $1 AND e.created_by = $2
            FOR UPDATE OF e
          `, [params.id, actor.userId]);
          if (!row) throw new HttpError(404, 'DRAFT_NOT_FOUND', 'Expense draft not found.');
          const { id, groupId, totalCents, status, confirmedAt, expired, accountId, providerKey } = row;
          if (status === 'confirmed') return { expense: { id, groupId, totalCents, status, confirmedAt } };
          if (status !== 'draft' || expired) throw new HttpError(409, 'DRAFT_EXPIRED', 'Create a new expense draft.');
          // Include every share, even zero-cent shares, and keep those
          // membership keys locked until this confirmation transaction commits.
          // A concurrent removal must finish before this check or wait for it.
          const { rows: [{ authorized }] } = await db.query(`
            WITH participants AS MATERIALIZED (
              SELECT user_id FROM expense_shares WHERE expense_id = $1
              UNION SELECT $3::uuid
            ), current_members AS MATERIALIZED (
              SELECT m.user_id FROM group_members m
              JOIN participants p ON p.user_id = m.user_id
              WHERE m.group_id = $2
              ORDER BY m.user_id
              FOR KEY SHARE OF m
            )
            SELECT NOT EXISTS (
              SELECT 1 FROM participants p
              WHERE NOT EXISTS (SELECT 1 FROM current_members m WHERE m.user_id = p.user_id)
            ) AS authorized
          `, [id, groupId, actor.userId]);
          if (!authorized) {
            throw new HttpError(403, 'PARTICIPANT_NOT_A_MEMBER', 'A participant is no longer in this group. Create a new expense draft.');
          }
          if (accountId) await requirePurchase(db, actor.userId, { accountId, providerKey }, totalCents);
          const { rows: [confirmed] } = await db.query(`
            UPDATE expenses SET status = 'confirmed', confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = $1
            RETURNING status, confirmed_at AS "confirmedAt"
          `, [id]);
          await recordGuardEvent(db, { actorUserId: actor.userId, groupId, expenseId: id,
            reasonCode: 'EXPENSE_CONFIRMED' });
          return { expense: { id, groupId, totalCents, ...confirmed } };
        });
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'expenses_confirmed_bank_purchase_uq') {
          throw new HttpError(409, 'PURCHASE_ALREADY_LINKED', 'This purchase is already linked to an expense.');
        }
        throw error;
      }
    },

    async 'settlementReviews.create'({ actor, body }) {
      const { groupId, payeeUserId } = body;
      if (typeof groupId !== 'string' || !uuid.test(groupId) ||
          typeof payeeUserId !== 'string' || !uuid.test(payeeUserId)) {
        throw invalid('Choose a valid group and recipient.');
      }
      const payerUserId = actor.userId;
      return withTransaction(async (db) => {
        const group = await requireGroup(db, groupId, payerUserId);
        await requireGroup(db, groupId, payeeUserId);
        const debts = await readDebts(db, [group.id], payerUserId);
        const debt = debts.find(({ userId, cents }) => userId === payeeUserId.toLowerCase() && cents > 0);
        if (!debt) throw new HttpError(409, 'NO_OUTSTANDING_DEBT', 'There is no outstanding debt to this member.');
        const payer = await getMappedAccountForUser(db, payerUserId);
        const payee = await getMappedAccountForUser(db, debt.userId);
        if (!payer || !payee) throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Both members need a connected sandbox account.');
        const { rows: [review] } = await db.query(`
          INSERT INTO settlements (group_id, created_by, payer_user_id, payee_user_id,
            payer_account_id, payee_account_id, amount_cents, review_expires_at)
          VALUES ($1, $2, $2, $3, $4, $5, $6, now() + interval '15 minutes')
          RETURNING id, group_id AS "groupId", payer_user_id AS "payerUserId",
            payee_user_id AS "payeeUserId", amount_cents AS "amountCents",
            status, review_expires_at AS "expiresAt"
        `, [group.id, payerUserId, debt.userId, payer.id, payee.id, debt.cents]);
        return { review };
      });
    },

    async 'groups.get'({ actor, params }) {
      if (!uuid.test(params.id)) throw invalid('Enter a valid group ID.');
      const group = await requireGroup({ query }, params.id, actor.userId);
      const { rows: members } = await query(`
        SELECT u.id AS "userId", u.display_name AS "displayName", u.full_name AS "fullName",
          u.handle, u.initials, u.id = $2 AS "isYou"
        FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY "isYou" DESC, m.joined_at, u.id
      `, [group.id, actor.userId]);
      const [debts, ledger] = await Promise.all([
        readDebts({ query }, [group.id], actor.userId).then(summarizeDebts),
        readLedger({ query }, group.id, actor.userId),
      ]);
      return { group, members, debts, ledger };
    },
  };
}
