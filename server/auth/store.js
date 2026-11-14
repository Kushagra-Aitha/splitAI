// B8 · Where users and sessions live. The server uses the Tiger Data store;
// tests use the in-memory store with the same interface.
//
// Sessions are keyed by SHA-256 of the cookie token, so a database read never
// reveals a usable cookie.
import { randomUUID } from 'node:crypto';
import { hashPassword } from './password.js';

const userColumns = `u.id AS "userId", COALESCE(u.full_name, u.display_name) AS "displayName"`;

export function createDbAuthStore({ query }) {
  return {
    async findUserByEmail(email) {
      const { rows: [user] } = await query(
        `SELECT ${userColumns}, u.password_hash AS "passwordHash" FROM users u WHERE u.email = $1`,
        [email],
      );
      return user ?? null;
    },

    /** Returns the new user, or null when the email is already registered. */
    async createUser({ email, displayName, fullName, initials, passwordHash }) {
      try {
        const { rows: [user] } = await query(
          `INSERT INTO users AS u (handle, display_name, full_name, initials, email, password_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${userColumns}`,
          [`user-${randomUUID()}`, displayName, fullName, initials, email, passwordHash],
        );
        return user;
      } catch (error) {
        if (error.code === '23505') return null;
        throw error;
      }
    },

    async createSession({ tokenHash, userId, csrfToken, expiresAt }) {
      await query(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [tokenHash, userId, csrfToken, expiresAt],
      );
    },

    async findSession(tokenHash, now) {
      const { rows: [session] } = await query(
        `SELECT ${userColumns}, s.csrf_token AS "csrfToken",
                (extract(epoch FROM s.expires_at) * 1000)::bigint AS "expiresAt"
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > to_timestamp($2 / 1000.0)`,
        [tokenHash, now],
      );
      if (!session) return null;
      const { userId, displayName, csrfToken, expiresAt } = session;
      return { actor: { userId, displayName }, csrfToken, expiresAt: Number(expiresAt) };
    },

    async deleteSession(tokenHash) {
      await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    async deleteExpired(now) {
      await query('DELETE FROM sessions WHERE expires_at <= to_timestamp($1 / 1000.0)', [now]);
    },
  };
}

export function createMemoryAuthStore() {
  const users = new Map(); // email → user
  const sessions = new Map(); // token hash (hex) → session
  const key = (tokenHash) => Buffer.from(tokenHash).toString('hex');
  const store = {
    async findUserByEmail(email) {
      return users.get(email) ?? null;
    },
    async createUser({ email, displayName, fullName, passwordHash, userId = randomUUID() }) {
      if (users.has(email)) return null;
      users.set(email, { userId, displayName: fullName ?? displayName, passwordHash });
      return { userId, displayName: fullName ?? displayName };
    },
    async createSession({ tokenHash, userId, csrfToken, expiresAt }) {
      const user = [...users.values()].find((u) => u.userId === userId);
      sessions.set(key(tokenHash), { actor: { userId, displayName: user.displayName }, csrfToken, expiresAt });
    },
    async findSession(tokenHash, now) {
      const session = sessions.get(key(tokenHash));
      return session && session.expiresAt > now ? structuredClone(session) : null;
    },
    async deleteSession(tokenHash) {
      sessions.delete(key(tokenHash));
    },
    async deleteExpired(now) {
      for (const [k, session] of sessions) if (session.expiresAt <= now) sessions.delete(k);
    },
    /** Test helper: register a user with a known ID and password. */
    async addUser({ userId, email, displayName, password }) {
      return store.createUser({ userId, email, displayName, passwordHash: await hashPassword(password) });
    },
  };
  return store;
}
