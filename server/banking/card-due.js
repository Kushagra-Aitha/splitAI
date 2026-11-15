import { monthDate, today } from '../capital-two/input.js';

export const DEFAULT_STATEMENT_DUE_DAY = 25;

export function nextStatementDueDate(day, from = today()) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const [year, month] = from.split('-').map(Number);
  const thisMonth = monthDate(year, month - 1, day);
  return thisMonth >= from ? thisMonth : monthDate(year, month, day);
}

export function cardAmountDue(account) {
  if (!Number.isSafeInteger(account.creditLimitCents) || !Number.isSafeInteger(account.availableCents)) return null;
  return Math.max(0, account.creditLimitCents - account.availableCents);
}
