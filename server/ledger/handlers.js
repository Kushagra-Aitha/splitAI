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
      return { groups: rows.map((group) => ({ ...group, youOweCents: 0, owedToYouCents: 0 })) };
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
      if (body.bankRef != null) {
        throw new HttpError(501, 'BANK_LINK_NOT_IMPLEMENTED', 'Linking a bank purchase is not available yet.');
      }

      return withTransaction(async (db) => {
        const group = await requireGroup(db, groupId, actor.userId);
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
          INSERT INTO expenses (group_id, created_by, merchant, category, total_cents, expires_at)
          VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes')
          RETURNING id, status, created_at AS "createdAt", expires_at AS "expiresAt"
        `, [group.id, actor.userId, merchant, category, cents]);
        await db.query(`
          INSERT INTO expense_shares (expense_id, user_id, share_cents)
          SELECT $1, user_id, share_cents
          FROM unnest($2::uuid[], $3::bigint[]) AS shares(user_id, share_cents)
        `, [draft.id, shares.map((share) => share.userId), shares.map((share) => share.cents)]);
        return {
          draft: {
            ...draft, groupId: group.id, payerUserId: actor.userId, merchant, category,
            totalCents: cents, shares, bankRef: null,
          },
        };
      });
    },



    async 'groups.get'({ actor, params }) {
      if (!uuid.test(params.id)) throw invalid('Enter a valid group ID.');
      const group = await requireGroup({ query }, params.id, actor.userId);
      const { rows: members } = await query(`
        SELECT u.id AS "userId", u.display_name AS "displayName", u.initials, u.id = $2 AS "isYou"
        FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY "isYou" DESC, m.joined_at, u.id
      `, [group.id, actor.userId]);
      return { group, members, debts: { youOwe: [], owedToYou: [], youOweCents: 0, owedToYouCents: 0 }, ledger: [] };
    },
  };
}
