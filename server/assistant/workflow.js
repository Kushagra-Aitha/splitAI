import { createHash } from 'node:crypto';
import { HttpError } from '../http.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { createAskHandler } from './ask.js';
import { validateConversation, validateIntent, validateMessage } from './intent.js';
import { createAssistantGuard, rejectedProposalReason } from './guard.js';
import { chargeExplanationTarget } from '../ledger/explain-charge.js';
import { bankQuery, matchPurchases } from './bank-match.js';
import { answerGoalProgress } from './goal-progress.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const invalid = (message) => new HttpError(422, 'INVALID_ASK_SELECTION', message);
const columns = `id, message_hash AS "messageHash", extraction,
  draft_id AS "draftId", selection_hash AS "selectionHash", expires_at AS "expiresAt", bank_query AS "bankQuery"`;
const paymentLanguage = /\b(?:pay|paying|payment|owe|owed|settle|repay|reimburse)\b/iu;
const usd = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function clarifyPayment(expense = null) {
  const person = expense?.participantNames?.length === 1 ? expense.participantNames[0] : null;
  const merchant = expense?.merchant;
  const amount = Number.isSafeInteger(expense?.cents) ? usd(expense.cents) : null;
  const subject = [amount, merchant ? `for ${merchant}` : null].filter(Boolean).join(' ');
  return {
    type: 'clarification',
    intent: 'payment_clarification',
    answer: `I haven’t matched this to a logged transaction, and no expense or payment was created. Did ${person ? `${person} pay` : 'someone else pay'}${merchant ? ` for ${merchant}` : ''} and you want to settle${amount ? ` ${amount}` : ''}, or did you pay and want to split${subject ? ` ${subject}` : ' the purchase'}? Use Settle up for a debt, or mention the card or bank transaction to match a purchase.`,
    choices: [
      { label: person ? `${person} paid — check what I owe` : 'Someone else paid — check what I owe',
        message: person ? `What do I owe ${person}?` : 'What do I owe?' },
      { label: 'I paid — record a split',
        message: `I paid${amount ? ` ${amount}` : ''}${merchant ? ` at ${merchant}` : ''} and want to split it${person ? ` with ${person}` : ''}.` },
    ],
  };
}

function id(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`Choose a valid ${label}.`);
  return value.toLowerCase();
}

function details(extraction, selection) {
  const merchant = selection?.merchant === undefined ? extraction.merchant : selection.merchant;
  const cents = selection?.cents === undefined ? extraction.cents : selection.cents;
  if (merchant !== null && (typeof merchant !== 'string' || !merchant.trim() || merchant.length > 60 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(merchant))) {
    throw invalid('Enter a merchant between 1 and 60 characters.');
  }
  if (cents !== null && (!Number.isSafeInteger(cents) || cents <= 0)) throw invalid('Enter a positive amount in integer cents.');
  return { ...extraction, merchant: merchant?.trim() ?? null, cents };
}

function selectedMembers(selection, members, actorId) {
  if (!Array.isArray(selection.participantIds) || selection.participantIds.length > 21) throw invalid('Choose group participants.');
  const selected = selection.participantIds.map((value) => id(value, 'participant'));
  if (new Set(selected).size !== selected.length) throw invalid('Choose each participant only once.');
  const eligible = new Set(members.map((member) => member.userId));
  const participantIds = [actorId, ...selected.filter((value) => value !== actorId)];
  if (participantIds.some((value) => !eligible.has(value))) {
    throw new HttpError(403, 'PARTICIPANT_NOT_A_MEMBER', 'Choose participants from this group.');
  }
  return participantIds;
}

function resolveNames(extraction, members, actorId) {
  const participantIds = [actorId];
  const unresolvedNames = [];
  const seen = new Set();
  for (const name of extraction.participantNames) {
    const candidates = members.filter((member) => normalized(member.displayName) === normalized(name) ||
      (member.fullName && normalized(member.fullName) === normalized(name)));
    if (candidates.length !== 1 || seen.has(candidates[0].userId)) {
      unresolvedNames.push(name);
    } else {
      seen.add(candidates[0].userId);
      if (candidates[0].userId !== actorId) participantIds.push(candidates[0].userId);
    }
  }
  return { participantIds, unresolvedNames };
}

async function readDraft(db, proposal, actorId) {
  const { rows: [row] } = await db.query(`
    SELECT e.id, e.status, e.group_id AS "groupId", e.created_by AS "payerUserId",
      e.merchant, e.category, e.total_cents::text AS "totalCents",
      e.created_at AS "createdAt", e.expires_at AS "expiresAt", g.name AS "groupName", g.kind,
      e.bank_account_id AS "bankAccountId", e.bank_provider_key AS "bankProviderKey"
    FROM expenses e JOIN groups g ON g.id = e.group_id
    JOIN group_members m ON m.group_id = e.group_id AND m.user_id = $2 AND m.left_at IS NULL
    WHERE e.id = $1 AND e.created_by = $2`, [proposal.draftId, actorId]);
  if (!row) throw new HttpError(403, 'DRAFT_SCOPE_FORBIDDEN', 'This expense review is not available in your groups.');
  if (row.status !== 'confirmed' && (row.status !== 'draft' || row.expiresAt <= new Date())) {
    throw new HttpError(409, 'DRAFT_EXPIRED', 'This expense review expired. Start a new message.');
  }
  const { rows: shares } = await db.query(`
    SELECT s.user_id AS "userId", u.display_name AS "displayName", s.share_cents::text AS cents
    FROM expense_shares s JOIN users u ON u.id = s.user_id
    WHERE s.expense_id = $1 ORDER BY (s.user_id = $2) DESC, s.user_id`, [row.id, actorId]);
  const totalCents = Number(row.totalCents);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || shares.some((share) => !Number.isSafeInteger(Number(share.cents)) || Number(share.cents) < 0)) {
    throw new HttpError(409, 'DRAFT_STATE_INVALID', 'This expense review needs to be created again.');
  }
  if (shares.reduce((sum, share) => sum + BigInt(share.cents), 0n) !== BigInt(row.totalCents)) {
    throw new HttpError(409, 'DRAFT_STATE_INVALID', 'This expense review needs to be created again.');
  }
  const { groupName, kind, bankAccountId, bankProviderKey, ...draft } = row;
  return {
    type: 'draft', proposalId: proposal.id,
    group: { id: row.groupId, name: groupName, kind },
    draft: { ...draft, totalCents, shares: shares.map((share) => ({ ...share, cents: Number(share.cents) })),
      bankRef: bankAccountId ? { accountId: bankAccountId, providerKey: bankProviderKey } : null },
  };
}

async function advance(db, proposal, actor, selection) {
  const ledger = createLedgerHandlers({ query: (...args) => db.query(...args), withTransaction: (fn) => fn(db) });
  const original = validateIntent({ intent: 'expense', expense: proposal.extraction }).expense;
  if (proposal.draftId && !selection) return readDraft(db, proposal, actor.userId);
  if (!proposal.draftId && proposal.expiresAt <= new Date()) {
    throw new HttpError(409, 'PROPOSAL_EXPIRED', 'This expense proposal expired. Start a new message.');
  }
  const extraction = details(original, selection);
  const bank = await matchPurchases(db, actor.userId, proposal.bankQuery, selection?.bankRef, proposal.draftId);
  if (bank.purchase && selection?.cents !== undefined && selection.cents !== bank.purchase.cents) {
    throw invalid('The amount must match the selected bank purchase.');
  }
  if (bank.purchase) { extraction.merchant = bank.purchase.merchant || extraction.merchant; extraction.cents = bank.purchase.cents; }
  const { groups } = await ledger['groups.list']({ actor });
  const groupOptions = groups.map(({ id, name, kind }) => ({ id, name, kind }));
  let groupId = selection?.groupId !== undefined && selection.groupId !== null ? id(selection.groupId, 'group') : null;
  if (!groupId) {
    const matches = extraction.groupHint
      ? groupOptions.filter((group) => normalized(group.name) === normalized(extraction.groupHint))
      : groupOptions;
    if (matches.length === 1) groupId = matches[0].id;
  }
  if (groupId && !groupOptions.some((group) => group.id === groupId)) {
    throw new HttpError(403, 'GROUP_SCOPE_FORBIDDEN', 'Choose one of your groups.');
  }
  let members = [];
  let participantIds = [actor.userId];
  let unresolvedNames = extraction.participantNames;
  const explicitMembers = selection && Object.hasOwn(selection, 'participantIds');
  if (groupId) {
    ({ members } = await ledger['groups.get']({ actor, params: { id: groupId } }));
    if (explicitMembers) {
      participantIds = selectedMembers(selection, members, actor.userId);
      unresolvedNames = [];
    } else {
      ({ participantIds, unresolvedNames } = resolveNames(extraction, members, actor.userId));
    }
  }
  const missingFields = [];
  if (extraction.merchant === null) missingFields.push('merchant');
  if (extraction.cents === null) missingFields.push('cents');
  if (proposal.bankQuery && !bank.purchase) missingFields.push('bankPurchase');
  if (!explicitMembers && !extraction.participantNames.length) missingFields.push('participantNames');
  if (!groupId || missingFields.length || unresolvedNames.length) {
    return {
      type: 'selection_needed', intent: 'expense', proposalId: proposal.id,
      reason: !groupId ? 'GROUP_REQUIRED' : missingFields.length ? 'EXPENSE_DETAILS_REQUIRED' : 'MEMBERS_REQUIRED',
      extraction, missingFields, groups: groupOptions, groupId, members,
      suggestedParticipantIds: participantIds, unresolvedNames, expiresAt: proposal.expiresAt,
      bankCandidates: bank.candidates, requiresBankPurchase: !!proposal.bankQuery,
      selectedBankRef: bank.purchase ? { accountId: bank.purchase.accountId, providerKey: bank.purchase.providerKey } : null,
    };
  }
  const bankRef = bank.purchase ? { accountId: bank.purchase.accountId, providerKey: bank.purchase.providerKey } : null;
  const selectionHash = hash({ groupId, merchant: extraction.merchant, cents: extraction.cents, participantIds: [...participantIds].sort(), bankRef });
  if (proposal.draftId) {
    if (proposal.selectionHash !== selectionHash) throw new HttpError(409, 'PROPOSAL_ALREADY_REVIEWED', 'This proposal already has a review. Start a new message to change it.');
    return readDraft(db, proposal, actor.userId);
  }
  // Reuse A2 in this SAME transaction: draft/shares and proposal binding either
  // commit together or roll back together. A2's own transaction wrapper is
  // deliberately bound to this client, so a lost response cannot orphan a draft.
  const { draft } = await ledger['expenseDrafts.create']({ actor, body: {
    groupId, merchant: extraction.merchant, cents: extraction.cents, participantIds, bankRef,
  } });
  await db.query("UPDATE expenses SET source = 'chat' WHERE id = $1", [draft.id]);
  await db.query('UPDATE assistant_proposals SET draft_id = $2, selection_hash = $3 WHERE id = $1', [proposal.id, draft.id, selectionHash]);
  return { type: 'draft', proposalId: proposal.id, draft, group: groupOptions.find((group) => group.id === groupId) };
}

export function createAskWorkflow({ parseIntent, query, withTransaction, answerFinancial, conversationalReads, prepareReminder, explainCharge,
  guard = createAssistantGuard({ withTransaction }) }) {
  const run = async ({ actor, body }) => {
    if (body?.proposalId !== undefined) {
      if (Object.hasOwn(body, 'message')) throw invalid('Send a message or a proposal selection, not both.');
      if (Object.keys(body).some((key) => !['proposalId', 'selection'].includes(key))) throw invalid('Send only the proposal ID and selection.');
      const proposalId = id(body.proposalId, 'proposal');
      if (!body.selection || typeof body.selection !== 'object' || Array.isArray(body.selection) ||
          Object.keys(body.selection).some((key) => !['groupId', 'participantIds', 'merchant', 'cents', 'bankRef'].includes(key))) {
        throw invalid('Choose the expense group, participants, and details.');
      }
      return withTransaction(async (db) => {
        const { rows: [proposal] } = await db.query(`SELECT ${columns} FROM assistant_proposals
          WHERE id = $1 AND actor_user_id = $2 FOR UPDATE`, [proposalId, actor.userId]);
        if (!proposal) throw new HttpError(403, 'PROPOSAL_SCOPE_FORBIDDEN', 'Choose an expense proposal from your own session.');
        return advance(db, proposal, actor, body.selection);
      });
    }
    if (!body || Object.keys(body).some((key) => !['message', 'requestKey', 'context', 'conversation'].includes(key))) {
      throw invalid('Send only a message, request key, bounded conversation topics, and optional group-note context.');
    }
    const message = validateMessage(body);
    const conversation = validateConversation(body.conversation);
    const requestKey = id(body.requestKey, 'request key');
    if (Object.hasOwn(body, 'context')) return guard.reviewNote({ actor, context: body.context });
    const messageHash = hash(message);
    const { rows: [existing] } = await query(`SELECT ${columns} FROM assistant_proposals
      WHERE actor_user_id = $1 AND request_key = $2`, [actor.userId, requestKey]);
    if (existing && existing.messageHash !== messageHash) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
    const merchant = !existing && explainCharge ? chargeExplanationTarget(message) : null;
    if (merchant) {
      const asOf = new Date().toISOString();
      return { ...await explainCharge({ actor, merchant }), asOf,
        conversation: { intent: 'explain_charge', merchant, category: null, from: null, to: null } };
    }
    // No DB connection or transaction is held across the model request.
    const parsed = validateIntent(existing ? { intent: 'expense', expense: existing.extraction } : await parseIntent(message, conversation));
    if (parsed.intent === 'goal_progress') return withTransaction((db) => answerGoalProgress(db, actor.userId));
    if (parsed.intent === 'reminder' && prepareReminder) return prepareReminder(actor, parsed.expense, requestKey);
    if (parsed.intent === 'reminder') throw new HttpError(503, 'REMINDERS_UNAVAILABLE', 'Reminders are not available yet.');
    if (parsed.intent === 'payment_clarification') return clarifyPayment(parsed.expense);
    if (parsed.intent === 'explain_charge' && explainCharge) {
      const previousMerchant = [...conversation].reverse().find((topic) => topic.merchant)?.merchant;
      if (!previousMerchant) {
        return { type: 'clarification', intent: 'explain_charge',
          answer: 'Which merchant charge do you want explained?', choices: [] };
      }
      const asOf = new Date().toISOString();
      return { ...await explainCharge({ actor, merchant: previousMerchant }), asOf,
        conversation: { intent: 'explain_charge', merchant: previousMerchant, category: null, from: null, to: null } };
    }
    if (parsed.intent === 'transactions' && conversationalReads) return conversationalReads.transactions({ actor, query: parsed.query });
    if (parsed.intent === 'spending_guidance' && conversationalReads) return conversationalReads.spendingGuidance({ actor, query: parsed.query });
    if (parsed.intent === 'unsupported') {
      if (paymentLanguage.test(message)) return clarifyPayment();
      return {
        type: 'answer',
        intent: 'unsupported',
        answer: 'I can help with expenses, balances, spending, goals, reminders, and charge explanations. No changes were made.',
      };
    }
    if (parsed.intent !== 'expense') {
      if (answerFinancial) return answerFinancial({ actor, intent: parsed.intent });
      return createAskHandler({ parseIntent: async () => parsed })({ body: { message } });
    }
    const criteria = existing ? existing.bankQuery : bankQuery(message, parsed.expense);
    return withTransaction(async (db) => {
      await db.query(`INSERT INTO assistant_proposals (actor_user_id, request_key, message_hash, extraction, bank_query)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) ON CONFLICT (actor_user_id, request_key) DO NOTHING`,
      [actor.userId, requestKey, messageHash, JSON.stringify(parsed.expense), criteria == null ? null : JSON.stringify(criteria)]);
      const { rows: [proposal] } = await db.query(`SELECT ${columns} FROM assistant_proposals
        WHERE actor_user_id = $1 AND request_key = $2 FOR UPDATE`, [actor.userId, requestKey]);
      if (proposal.messageHash !== messageHash) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
      return advance(db, proposal, actor);
    });
  };
  return async (context) => {
    try { return await run(context); } catch (error) {
      const reasonCode = rejectedProposalReason(error);
      if (!reasonCode) throw error;
      // A failed draft transaction has rolled back before a separate audit
      // transaction records this decision. No settlement service is available
      // to this workflow, regardless of model output or request fields.
      return guard.block({ actor: context.actor, reasonCode });
    }
  };
}
