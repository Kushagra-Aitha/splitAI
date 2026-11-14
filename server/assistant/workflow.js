import { createHash } from 'node:crypto';
import { HttpError } from '../http.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { createAskHandler } from './ask.js';
import { validateIntent, validateMessage } from './intent.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const invalid = (message) => new HttpError(422, 'INVALID_ASK_SELECTION', message);
const columns = `id, message_hash AS "messageHash", extraction,
  draft_id AS "draftId", selection_hash AS "selectionHash", expires_at AS "expiresAt"`;

function id(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`Choose a valid ${label}.`);
  return value.toLowerCase();
}

function details(extraction, selection) {
  const merchant = selection?.merchant === undefined ? extraction.merchant : selection.merchant;
  const cents = selection?.cents === undefined ? extraction.cents : selection.cents;
  if (merchant !== null && (typeof merchant !== 'string' || !merchant.trim() || merchant.length > 60 || /\p{Cc}/u.test(merchant))) {
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
      e.created_at AS "createdAt", e.expires_at AS "expiresAt", g.name AS "groupName", g.kind
    FROM expenses e JOIN groups g ON g.id = e.group_id
    JOIN group_members m ON m.group_id = e.group_id AND m.user_id = $2
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
  const { groupName, kind, ...draft } = row;
  return {
    type: 'draft', proposalId: proposal.id,
    group: { id: row.groupId, name: groupName, kind },
    draft: { ...draft, totalCents, shares: shares.map((share) => ({ ...share, cents: Number(share.cents) })), bankRef: null },
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
  if (!explicitMembers && !extraction.participantNames.length) missingFields.push('participantNames');
  if (!groupId || missingFields.length || unresolvedNames.length) {
    return {
      type: 'selection_needed', intent: 'expense', proposalId: proposal.id,
      reason: !groupId ? 'GROUP_REQUIRED' : missingFields.length ? 'EXPENSE_DETAILS_REQUIRED' : 'MEMBERS_REQUIRED',
      extraction, missingFields, groups: groupOptions, groupId, members,
      suggestedParticipantIds: participantIds, unresolvedNames, expiresAt: proposal.expiresAt,
    };
  }
  const selectionHash = hash({ groupId, merchant: extraction.merchant, cents: extraction.cents, participantIds: [...participantIds].sort() });
  if (proposal.draftId) {
    if (proposal.selectionHash !== selectionHash) throw new HttpError(409, 'PROPOSAL_ALREADY_REVIEWED', 'This proposal already has a review. Start a new message to change it.');
    return readDraft(db, proposal, actor.userId);
  }
  // Reuse A2 in this SAME transaction: draft/shares and proposal binding either
  // commit together or roll back together. A2's own transaction wrapper is
  // deliberately bound to this client, so a lost response cannot orphan a draft.
  const { draft } = await ledger['expenseDrafts.create']({ actor, body: {
    groupId, merchant: extraction.merchant, cents: extraction.cents, participantIds,
  } });
  await db.query("UPDATE expenses SET source = 'chat' WHERE id = $1", [draft.id]);
  await db.query('UPDATE assistant_proposals SET draft_id = $2, selection_hash = $3 WHERE id = $1', [proposal.id, draft.id, selectionHash]);
  return { type: 'draft', proposalId: proposal.id, draft, group: groupOptions.find((group) => group.id === groupId) };
}

export function createAskWorkflow({ parseIntent, query, withTransaction, answerFinancial }) {
  return async ({ actor, body }) => {
    if (body?.proposalId !== undefined) {
      if (Object.hasOwn(body, 'message')) throw invalid('Send a message or a proposal selection, not both.');
      const proposalId = id(body.proposalId, 'proposal');
      if (!body.selection || typeof body.selection !== 'object' || Array.isArray(body.selection) ||
          Object.keys(body.selection).some((key) => !['groupId', 'participantIds', 'merchant', 'cents'].includes(key))) {
        throw invalid('Choose the expense group, participants, and details.');
      }
      return withTransaction(async (db) => {
        const { rows: [proposal] } = await db.query(`SELECT ${columns} FROM assistant_proposals
          WHERE id = $1 AND actor_user_id = $2 FOR UPDATE`, [proposalId, actor.userId]);
        if (!proposal) throw new HttpError(403, 'PROPOSAL_SCOPE_FORBIDDEN', 'Choose an expense proposal from your own session.');
        return advance(db, proposal, actor, body.selection);
      });
    }
    const message = validateMessage(body);
    const requestKey = id(body.requestKey, 'request key');
    const messageHash = hash(message);
    const { rows: [existing] } = await query(`SELECT ${columns} FROM assistant_proposals
      WHERE actor_user_id = $1 AND request_key = $2`, [actor.userId, requestKey]);
    if (existing && existing.messageHash !== messageHash) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
    // No DB connection or transaction is held across the model request.
    const parsed = existing ? { intent: 'expense', expense: existing.extraction } : await parseIntent(message);
    if (parsed.intent !== 'expense') {
      if (parsed.intent !== 'unsupported' && answerFinancial) return answerFinancial({ actor, intent: parsed.intent });
      return createAskHandler({ parseIntent: async () => parsed })({ body: { message } });
    }
    return withTransaction(async (db) => {
      await db.query(`INSERT INTO assistant_proposals (actor_user_id, request_key, message_hash, extraction)
        VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (actor_user_id, request_key) DO NOTHING`,
      [actor.userId, requestKey, messageHash, JSON.stringify(parsed.expense)]);
      const { rows: [proposal] } = await db.query(`SELECT ${columns} FROM assistant_proposals
        WHERE actor_user_id = $1 AND request_key = $2 FOR UPDATE`, [actor.userId, requestKey]);
      if (proposal.messageHash !== messageHash) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
      return advance(db, proposal, actor);
    });
  };
}
