import { createHash } from 'node:crypto';
import { lockAccount, reserveFunds, getSpendableFunds, InsufficientFundsError, BalanceUnknownError, InvalidAmountError } from '../banking/funds.js';
import { accountIdForUser } from '../banking/overview.js';
import { HttpError } from '../http.js';
import { listGoals, goalColumns, goalFromRow, readCents, invalidGoalState } from './read.js';
import { goalHistory } from './history.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const invalid = (message) => new HttpError(422, 'INVALID_GOAL_INPUT', message);
const conflict = () => new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different goal operation.');
const forbidden = () => new HttpError(403, 'GOAL_SCOPE_FORBIDDEN', 'Choose a goal belonging to your account.');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`Enter a valid ${label}.`);
  return value.toLowerCase();
}

function amount(value, label, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw invalid(`${label} must be ${zero ? 'nonnegative' : 'positive'} integer cents within the supported range.`);
  return value;
}

function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw invalid('Send only the supported goal fields.');
}

export function creationInput(body) {
  fields(body, ['name', 'type', 'targetCents', 'initialCents', 'targetDate', 'requestKey']);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 45 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(body.name)) throw invalid('Give your goal a name between 1 and 45 characters.');
  if (!['house', 'car', 'trip', 'savings'].includes(body.type)) throw invalid('Choose a supported goal type.');
  const targetDate = body.targetDate ?? null;
  if (targetDate !== null) {
    if (typeof targetDate !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(targetDate) || targetDate.startsWith('0000')) throw invalid('Use a real target date or leave it empty.');
    const date = new Date(`${targetDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== targetDate) throw invalid('Use a real target date or leave it empty.');
  }
  return { requestKey: uuid(body.requestKey, 'request key'), name: body.name.trim(), type: body.type,
    targetCents: amount(body.targetCents, 'Target'), initialCents: amount(body.initialCents ?? 0, 'Initial savings', true), targetDate };
}

export function movementInput(body) {
  fields(body, ['kind', 'cents', 'requestKey']);
  if (!['contribution', 'withdrawal'].includes(body.kind)) throw invalid('Choose contribution or withdrawal.');
  return { kind: body.kind, cents: amount(body.cents, 'Amount'), requestKey: uuid(body.requestKey, 'request key') };
}

function checkedFunds(funds) {
  for (const [key, value] of Object.entries(funds)) {
    if (key.endsWith('Cents') && value !== null && !Number.isSafeInteger(value)) throw invalidGoalState();
  }
  return funds;
}

async function accountGoals(db, accountId, actorId) {
  const { rows } = await db.query(`SELECT ${goalColumns}, g.user_id AS "userId" FROM goals g WHERE g.account_id = $1`, [accountId]);
  for (const row of rows) {
    if (row.userId !== actorId) throw invalidGoalState();
    goalFromRow(row); // Every cached hold must equal durable movements.
  }
}

async function readGoal(db, goalId, actorId) {
  const { rows: [row] } = await db.query(`SELECT ${goalColumns} FROM goals g
    JOIN bank_accounts a ON a.id = g.account_id
    WHERE g.id = $1 AND g.user_id = $2 AND a.user_id = $2 AND g.archived_at IS NULL`, [goalId, actorId]);
  if (!row) throw forbidden();
  return goalFromRow(row);
}

async function funds(db, accountId) { return checkedFunds(await getSpendableFunds(accountId, db)); }

function replay(response, goalId) {
  if (!response || response.goal?.id !== goalId || !Number.isSafeInteger(response.goal.savedCents) || response.goal.savedCents < 0 ||
      !Number.isSafeInteger(response.goal.targetCents) || response.goal.targetCents <= 0 || !response.funds) throw invalidGoalState();
  checkedFunds(response.funds);
  return response;
}

export function createGoalHandlers({ query, withTransaction }) {
  async function transaction(fn) {
    try { return await withTransaction(fn); } catch (error) {
      if (error instanceof InsufficientFundsError) throw new HttpError(409, error.code, 'There isn’t enough spendable money for this contribution. Nothing was saved.');
      if (error instanceof BalanceUnknownError) throw new HttpError(409, error.code, 'Refresh your bank balance before adding savings.');
      if (error instanceof InvalidAmountError) throw invalid('Enter positive integer cents.');
      throw error;
    }
  }
  return {
    'goals.list': ({ actor }) => listGoals({ query }, actor.userId),
    'goals.history': ({ actor, params, query: filters }) => goalHistory({ query }, actor.userId, params.id, filters),
    'goals.create': ({ actor, body }) => {
      const { requestKey, ...input } = creationInput(body);
      const payloadHash = hash(input);
      return transaction(async (db) => {
        const accountId = await accountIdForUser(db, actor.userId);
        if (!accountId) throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your demo bank account isn’t connected yet.');
        await lockAccount(db, accountId);
        const { rows: [existing] } = await db.query(`SELECT payload_hash AS hash, goal_id AS "goalId", response
          FROM goal_creation_requests WHERE actor_user_id = $1 AND request_key = $2`, [actor.userId, requestKey]);
        if (existing) {
          if (existing.hash !== payloadHash) throw conflict();
          await readGoal(db, existing.goalId, actor.userId);
          return replay(existing.response, existing.goalId);
        }
        await accountGoals(db, accountId, actor.userId);
        await funds(db, accountId);
        if (input.initialCents) await reserveFunds(db, accountId, input.initialCents);
        const { rows: [created] } = await db.query(`INSERT INTO goals
          (user_id, account_id, name, type, target_cents, saved_cents, target_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [actor.userId, accountId, input.name, input.type, input.targetCents, input.initialCents, input.targetDate]);
        let movement = null;
        if (input.initialCents) {
          ({ rows: [movement] } = await db.query(`INSERT INTO goal_movements
            (goal_id, actor_user_id, kind, amount_cents, request_key)
            VALUES ($1, $2, 'contribution', $3, $4)
            RETURNING id, goal_id AS "goalId", kind, amount_cents::text AS cents, request_key AS "requestKey", created_at AS "createdAt"`,
          [created.id, actor.userId, input.initialCents, requestKey]));
          movement.cents = readCents(movement.cents);
        }
        const response = { goal: await readGoal(db, created.id, actor.userId), movement, funds: await funds(db, accountId) };
        const serialized = JSON.stringify(response);
        if (movement) await db.query('UPDATE goal_movements SET response = $2::jsonb WHERE id = $1', [movement.id, serialized]);
        await db.query(`INSERT INTO goal_creation_requests (actor_user_id, request_key, account_id, payload_hash, goal_id, response)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [actor.userId, requestKey, accountId, payloadHash, created.id, serialized]);
        return JSON.parse(serialized);
      });
    },
    'goals.move': ({ actor, body, params }) => {
      const goalId = uuid(params.id, 'goal');
      const input = movementInput(body);
      return transaction(async (db) => {
        const initial = await readGoal(db, goalId, actor.userId);
        await lockAccount(db, initial.accountId);
        const goal = await readGoal(db, goalId, actor.userId);
        if (goal.accountId !== initial.accountId) throw invalidGoalState();
        const { rows: [existing] } = await db.query(`SELECT id, actor_user_id AS "actorId", kind, amount_cents::text AS cents, response
          FROM goal_movements WHERE goal_id = $1 AND request_key = $2`, [goalId, input.requestKey]);
        if (existing) {
          if (existing.actorId !== actor.userId || existing.kind !== input.kind || readCents(existing.cents) !== input.cents) throw conflict();
          return replay(existing.response, goalId);
        }
        await accountGoals(db, goal.accountId, actor.userId);
        await funds(db, goal.accountId);
        const saved = BigInt(goal.savedCents) + (input.kind === 'contribution' ? BigInt(input.cents) : -BigInt(input.cents));
        if (saved < 0n) throw new HttpError(409, 'INSUFFICIENT_SAVINGS', 'You cannot withdraw more than this goal has saved.');
        if (saved > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('This contribution would exceed the supported savings range.');
        if (input.kind === 'contribution') await reserveFunds(db, goal.accountId, input.cents);
        await db.query('UPDATE goals SET saved_cents = $2, updated_at = now() WHERE id = $1', [goalId, saved.toString()]);
        const { rows: [movement] } = await db.query(`INSERT INTO goal_movements
          (goal_id, actor_user_id, kind, amount_cents, request_key) VALUES ($1, $2, $3, $4, $5)
          RETURNING id, goal_id AS "goalId", kind, amount_cents::text AS cents, request_key AS "requestKey", created_at AS "createdAt"`,
        [goalId, actor.userId, input.kind, input.cents, input.requestKey]);
        movement.cents = readCents(movement.cents);
        const response = { goal: await readGoal(db, goalId, actor.userId), movement, funds: await funds(db, goal.accountId) };
        const serialized = JSON.stringify(response);
        await db.query('UPDATE goal_movements SET response = $2::jsonb WHERE id = $1', [movement.id, serialized]);
        return JSON.parse(serialized);
      });
    },
  };
}
