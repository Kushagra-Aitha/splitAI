import { HttpError } from '../http.js';
import { recordGuardEvent } from '../guard/events.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const unavailable = () => new HttpError(503, 'GUARD_UNAVAILABLE', 'Guard could not record this rejection. No action was authorized. Try again.');

export function createAssistantGuard({ withTransaction, recordEvent = recordGuardEvent }) {
  async function record(db, actor, reasonCode, groupId = null) {
    try {
      const eventId = await recordEvent(db, { actorUserId: actor.userId, groupId, reasonCode });
      if (typeof eventId !== 'string' || !UUID.test(eventId)) throw unavailable();
      // Render the actual stored decision, never a fabricated event ID or a
      // user/model-provided reason. A9 persists fixed, redacted descriptions.
      const { rows: [event] } = await db.query(`SELECT id AS "eventId", reason_code AS "reasonCode", reason,
        created_at AS "createdAt" FROM guard_events
        WHERE id = $1 AND actor_user_id = $2 AND source = 'assistant' AND decision = 'blocked'`, [eventId, actor.userId]);
      if (!event || typeof event.reason !== 'string') throw unavailable();
      return { type: 'blocked', ...event };
    } catch { throw unavailable(); }
  }
  return {
    block: async ({ actor, reasonCode }) => {
      try { return await withTransaction((db) => record(db, actor, reasonCode)); } catch { throw unavailable(); }
    },
    reviewNote: async ({ actor, context }) => {
      if (!context || typeof context !== 'object' || Array.isArray(context) ||
          Object.keys(context).length !== 2 || context.kind !== 'group_note' ||
          typeof context.groupId !== 'string' || !UUID.test(context.groupId)) {
        throw new HttpError(422, 'INVALID_ASK_CONTEXT', 'Choose a group note from one of your groups.');
      }
      try {
        return await withTransaction(async (db) => {
          const { rows: [group] } = await db.query(`SELECT g.id,
            nullif(btrim(g.tagline), '') IS NOT NULL AS "hasNote"
            FROM groups g JOIN group_members m ON m.group_id = g.id
            WHERE g.id = $1 AND m.user_id = $2 AND m.left_at IS NULL FOR KEY SHARE OF m`, [context.groupId, actor.userId]);
          if (!group) throw new HttpError(403, 'GROUP_SCOPE_FORBIDDEN', 'Choose one of your groups.');
          if (!group.hasNote) throw new HttpError(422, 'GROUP_NOTE_EMPTY', 'This group has no note to review.');
          // No semantic attack detector: ALL notes are non-authoritative. Even
          // innocuous text cannot authorize an expense/payment/read operation.
          // Raw notes never reach the model, audit context, logs, or a dispatcher.
          return record(db, actor, 'UNTRUSTED_CONTEXT', group.id);
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw unavailable();
      }
    },
  };
}

export function rejectedProposalReason(error) {
  if (!(error instanceof HttpError)) return null;
  if (error.code === 'INVALID_ASSISTANT_OUTPUT') return 'ASSISTANT_PROPOSAL_REJECTED';
  if (['GROUP_SCOPE_FORBIDDEN', 'GROUP_NOT_FOUND', 'PARTICIPANT_NOT_A_MEMBER', 'PROPOSAL_SCOPE_FORBIDDEN', 'DRAFT_SCOPE_FORBIDDEN'].includes(error.code)) return 'ASSISTANT_SCOPE_REJECTED';
  return null;
}
