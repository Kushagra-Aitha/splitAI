let revision = 0;
const listeners = new Set();

export const financialRevision = () => revision;
export function subscribeFinancialChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function financialChanged() {
  revision++;
  for (const listener of listeners) {
    // A view error must not turn a confirmed server mutation into a failed
    // request that invites an accidental duplicate financial operation.
    try { listener(); } catch { /* Other views still receive invalidation. */ }
  }
}
