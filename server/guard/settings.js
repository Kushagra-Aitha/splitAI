import { HttpError } from '../http.js';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function createGuardSettings({ query, withTransaction }) {
  return {
    async 'guard.settings.get'({ actor }) {
      const { rows: [row] } = await query('SELECT comment_alerts_enabled AS enabled FROM guard_settings WHERE user_id = $1', [actor.userId]);
      return { enabled: row?.enabled ?? true };
    },
    async 'guard.settings.update'({ actor, body }) {
      if (!body || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new HttpError(422, 'INVALID_GUARD_SETTING', 'Choose whether to receive comment alerts.');
      await query(`INSERT INTO guard_settings (user_id, comment_alerts_enabled) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET comment_alerts_enabled = excluded.comment_alerts_enabled,
        updated_at = clock_timestamp()`, [actor.userId, body.enabled]);
      return { enabled: body.enabled };
    },
    async 'guard.feedback'({ actor, params, body }) {
      if (!UUID.test(params.id) || !body || Object.keys(body).length !== 1 || !['ham', 'spam'].includes(body.label)) {
        throw new HttpError(422, 'INVALID_GUARD_FEEDBACK', 'Choose Not spam or Report.');
      }
      return withTransaction(async (db) => {
        const { rows: [event] } = await db.query(`SELECT group_id FROM guard_events
          WHERE id = $1 AND actor_user_id = $2 AND comment_id IS NOT NULL`, [params.id, actor.userId]);
        if (!event) throw new HttpError(404, 'GUARD_EVENT_NOT_FOUND', 'This comment alert is not available.');
        await db.query('SELECT id FROM groups WHERE id = $1 FOR KEY SHARE', [event.group_id]);
        const result = await db.query(`INSERT INTO guard_feedback (event_id, actor_user_id, label)
          SELECT e.id, $2, $3 FROM guard_events e JOIN group_members m ON m.group_id = e.group_id
            AND m.user_id = $2 AND m.left_at IS NULL
          WHERE e.id = $1 AND e.actor_user_id = $2 AND e.comment_id IS NOT NULL
          ON CONFLICT (event_id) DO UPDATE SET label = excluded.label, updated_at = clock_timestamp()
            WHERE guard_feedback.actor_user_id = $2 RETURNING event_id`, [params.id, actor.userId, body.label]);
        if (!result.rowCount) throw new HttpError(404, 'GUARD_EVENT_NOT_FOUND', 'This comment alert is not available.');
        return { recorded: true, label: body.label };
      });
    },
  };
}
