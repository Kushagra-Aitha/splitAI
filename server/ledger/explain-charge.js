import { HttpError } from '../http.js';
import { readDebts } from './debts.js';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'America/New_York' });
const money = (cents) => fmt.format(Number(cents) / 100);
const when = (value) => date.format(new Date(value));
const account = ({ accountKind, accountMask }) => {
  if (!accountKind) return null;
  const kind = accountKind === 'credit_card' ? 'credit card' : 'checking account';
  return accountMask ? `${kind} ending in ${accountMask}` : kind;
};
const missing = () => new HttpError(404, 'CHARGE_NOT_FOUND', 'Choose an expense or settlement in one of your groups.');

function expenseStatements(facts) {
  const { payerName, merchant, totalCents, groupName, occurredAt, chargeStatus, shares, yourShareCents,
    shared, isPayer, counterpartyBalanceCents } = facts;
  const statements = {
    charge: `${payerName} recorded ${money(totalCents)} for ${merchant} in ${groupName} on ${when(occurredAt)}.`,
    source: account(facts)
      ? `The linked purchase was made from the ${account(facts)}${chargeStatus ? ` and is ${chargeStatus}` : ''}.`
      : 'No bank account is linked to this expense.',
    split: `The split assigns ${shares.map((share) => `${money(share.cents)} to ${share.name}`).join(', ')}.`,
    share: `Your share is ${money(yourShareCents)}.`,
  };
  if (shared) {
    statements.balance = counterpartyBalanceCents
      ? (isPayer ? 'Some participants still have a net debt to you in this group.' : 'You still owe the payer on your net group balance.')
      : (isPayer ? 'None of the participants currently owe you on their net group balances.' : 'You have no net debt to the payer in this group.');
  }
  return statements;
}

function settlementStatements(facts) {
  const { payerName, payeeName, amountCents, groupName, occurredAt, status } = facts;
  return {
    payment: `${payerName} initiated a ${money(amountCents)} settlement with ${payeeName} in ${groupName} on ${when(occurredAt)}.`,
    ...(account(facts) ? { source: `The payment was initiated from the ${account(facts)}.` } : {}),
    status: {
      posted: 'The payment posted and was applied to their net group balance.',
      pending: 'The payment is pending verification. The group balance will update when it posts.',
      failed: 'The payment failed. This attempt did not reduce their group balance.',
    }[status],
  };
}

async function readExpense(db, actorId, groupId, expenseId) {
  const { rows: [expense] } = await db.query(`
    SELECT e.id, g.name AS "groupName", e.merchant, e.total_cents AS "totalCents",
      u.display_name AS "payerName", e.created_by AS "payerId", e.created_by = $1 AS "isPayer",
      coalesce(t.occurred_at, e.confirmed_at) AS "occurredAt", t.status AS "chargeStatus",
      a.kind AS "accountKind", CASE WHEN a.user_id = $1 THEN a.account_mask END AS "accountMask",
      coalesce((SELECT share_cents FROM expense_shares WHERE expense_id = e.id AND user_id = $1), 0) AS "yourShareCents",
      (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'cents', es.share_cents)
        ORDER BY p.display_name, p.id) FROM expense_shares es JOIN users p ON p.id = es.user_id
        WHERE es.expense_id = e.id) AS shares
    FROM expenses e JOIN groups g ON g.id = e.group_id JOIN users u ON u.id = e.created_by
    JOIN group_members m ON m.group_id = g.id AND m.user_id = $1 AND m.left_at IS NULL
    LEFT JOIN bank_accounts a ON a.id = e.bank_account_id
    LEFT JOIN bank_import_keys k ON k.account_id = e.bank_account_id AND k.provider_key = e.bank_provider_key
    LEFT JOIN bank_transactions t ON t.account_id = k.account_id AND t.id = k.transaction_id
      AND t.occurred_at = k.occurred_at
    WHERE e.group_id = $2 AND e.id = $3 AND e.status = 'confirmed'`, [actorId, groupId, expenseId]);
  if (!expense) throw missing();
  expense.shares ??= [];
  const counterparties = expense.isPayer
    ? expense.shares.filter(({ id, cents }) => id !== actorId && cents > 0).map(({ id }) => id)
    : expense.yourShareCents > 0 ? [expense.payerId] : [];
  const shared = counterparties.length > 0;
  const debts = shared ? await readDebts(db, [groupId], actorId) : [];
  const counterpartyBalanceCents = debts.reduce((sum, debt) => sum + (counterparties.includes(debt.userId)
    ? Math.max(0, expense.isPayer ? -debt.cents : debt.cents) : 0), 0);
  return { ...expense, shared, counterpartyBalanceCents };
}

async function readSettlement(db, actorId, groupId, settlementId) {
  const { rows: [settlement] } = await db.query(`
    SELECT s.id, g.name AS "groupName", p.display_name AS "payerName", q.display_name AS "payeeName",
      s.amount_cents AS "amountCents", s.status, coalesce(s.claimed_at, s.created_at) AS "occurredAt",
      a.kind AS "accountKind", CASE WHEN a.user_id = $1 THEN a.account_mask END AS "accountMask"
    FROM settlements s JOIN groups g ON g.id = s.group_id
    JOIN group_members m ON m.group_id = g.id AND m.user_id = $1 AND m.left_at IS NULL
    JOIN users p ON p.id = s.payer_user_id JOIN users q ON q.id = s.payee_user_id
    LEFT JOIN bank_accounts a ON a.id = s.payer_account_id
    WHERE s.group_id = $2 AND s.id = $3 AND s.status IN ('pending', 'posted', 'failed')`, [actorId, groupId, settlementId]);
  if (!settlement) throw missing();
  return settlement;
}

export function chargeExplanationTarget(message) {
  const match = /^(?:please\s+)?explain\s+(?:the\s+|my\s+)?(.+?)\s+(?:charge|expense)[?.!]*$/iu.exec(message.trim());
  return match?.[1]?.trim() || null;
}

export function createChargeExplanation({ withTransaction, explain }) {
  async function response(statements) {
    // The shared fact explainer may reorder these sentences. Its output is
    // assembled from statement IDs, so the model never supplies any figures.
    let answer;
    try { answer = await explain(statements); }
    catch { answer = Object.values(statements).join(' '); }
    return { type: 'answer', intent: 'explain_charge', answer };
  }

  async function byId({ actor, params }) {
    const { id: groupId, kind, entryId } = params;
    if (!uuid.test(groupId) || !uuid.test(entryId) || !['expense', 'settlement'].includes(kind)) throw missing();
    const statements = await withTransaction(async (db) => kind === 'expense'
      ? expenseStatements(await readExpense(db, actor.userId, groupId, entryId))
      : settlementStatements(await readSettlement(db, actor.userId, groupId, entryId)));
    return response(statements);
  }

  async function byMerchant({ actor, merchant }) {
    const statements = await withTransaction(async (db) => {
      const { rows } = await db.query(`
        SELECT e.id, e.group_id AS "groupId" FROM expenses e
        JOIN group_members m ON m.group_id = e.group_id AND m.user_id = $1 AND m.left_at IS NULL
        WHERE e.status = 'confirmed'
          AND regexp_replace(lower(e.merchant), '[^[:alnum:]]', '', 'g') =
            nullif(regexp_replace(lower($2), '[^[:alnum:]]', '', 'g'), '')
        ORDER BY e.confirmed_at DESC, e.id LIMIT 2`, [actor.userId, merchant]);
      if (rows.length !== 1) return { result: rows.length
        ? 'I found multiple matching expenses. Open the right group and choose Explain on the charge.'
        : 'I couldn’t find a matching confirmed expense in your groups.' };
      return expenseStatements(await readExpense(db, actor.userId, rows[0].groupId, rows[0].id));
    });
    return response(statements);
  }
  return { byId, byMerchant };
}
