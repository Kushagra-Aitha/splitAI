import { formatUsdCents } from '../../lib/money.js';

export function notificationMessage(item) {
  const actor = item.actorName || 'A group member';
  if (item.kind === 'guard_flagged') return `Guard flagged a suspicious comment from ${actor}`;
  if (item.kind === 'expense_added' && item.merchant && Number.isSafeInteger(item.totalCents)) {
    if (item.recurringOccurrence && Number.isSafeInteger(item.yourShareCents)) {
      const occurrence = new Date(`${item.recurringOccurrence.slice(0, 7)}-01T12:00:00Z`);
      const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(occurrence);
      return `${item.merchant} split for ${month} · ${item.isExpensePayer ? 'your share' : 'you owe'} ${formatUsdCents(item.yourShareCents)}`;
    }
    return `${actor} added ${item.merchant} ${formatUsdCents(item.totalCents)}${Number.isSafeInteger(item.yourShareCents) ? ` · your share ${formatUsdCents(item.yourShareCents)}` : ''}`;
  }
  if (item.kind === 'comment_added') return `${actor} commented${item.merchant ? ` on ${item.merchant}` : item.groupName ? ` in ${item.groupName}` : ''}`;
  if (item.kind.startsWith('settlement_') && Number.isSafeInteger(item.settlementCents)) {
    const amount = formatUsdCents(item.settlementCents);
    const state = { settlement_sent: 'was submitted', settlement_posted: 'posted', settlement_failed: 'failed' }[item.kind];
    return item.isPayer ? `Your ${amount} payment to ${item.payeeName || 'a group member'} ${state}` : `${actor}'s ${amount} payment to you ${state}`;
  }
  return ({ expense_added: 'A shared expense was added', settlement_sent: 'A payment was submitted',
    settlement_posted: 'A payment posted', settlement_failed: 'A payment failed', guard_blocked: 'Guard blocked a request' })[item.kind] || 'New activity';
}

export function relativeTime(value, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 60_000) return 'Just now';
  const units = elapsed < 3_600_000 ? ['minute', 60_000] : elapsed < 86_400_000 ? ['hour', 3_600_000] : ['day', 86_400_000];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.floor(elapsed / units[1]), units[0]);
}
