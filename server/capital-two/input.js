import { HttpError } from '../http.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const invalid = (message = 'Choose valid bank payment details.') => new HttpError(422, 'INVALID_BANK_INPUT', message);
export function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
export function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw invalid();
}
export function payeeText(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value) || !value.trim() || [...value.trim()].length > 80) throw invalid('Enter a payee from 1 to 80 characters.');
  return value.trim();
}
export function cents(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) throw invalid('Enter an amount from $0.01 to $1,000,000.');
  return value;
}
export function dateOnly(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('Choose a valid payment date.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid('Choose a valid payment date.');
  return value;
}
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}
export function monthDate(year, month, day) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10);
}
export function nextMonthly(date, day, inclusive = false) {
  const [year, month] = date.split('-').map(Number);
  const current = monthDate(year, month - 1, day);
  return (inclusive ? current >= date : current > date) ? current : monthDate(year, month, day);
}
export function operationInput(body) {
  fields(body, ['accountId', 'kind', 'payee', 'amountCents', 'requestKey']);
  if (!['purchase', 'withdrawal', 'card_payment'].includes(body.kind)) throw invalid();
  return { accountId: uuid(body.accountId), kind: body.kind,
    payee: body.kind === 'card_payment' ? 'Capital Two card payment' : body.kind === 'withdrawal' ? 'ATM withdrawal' : payeeText(body.payee),
    amountCents: cents(body.amountCents), requestKey: uuid(body.requestKey) };
}
export function scheduleInput(body, date = today()) {
  fields(body, ['accountId', 'payee', 'amountCents', 'requestKey', 'dayOfMonth', 'dueOn']);
  const recurring = body.dayOfMonth != null;
  if (recurring && (!Number.isInteger(body.dayOfMonth) || body.dayOfMonth < 1 || body.dayOfMonth > 31 || body.dueOn != null)) throw invalid();
  const dueOn = recurring ? nextMonthly(date, body.dayOfMonth, true) : dateOnly(body.dueOn);
  if (Number(dueOn.slice(0, 4)) > Number(date.slice(0, 4)) + 5) throw invalid('Choose a date within the next five years.');
  return { accountId: uuid(body.accountId), payee: payeeText(body.payee), amountCents: cents(body.amountCents),
    requestKey: uuid(body.requestKey), dayOfMonth: recurring ? body.dayOfMonth : null, dueOn };
}
