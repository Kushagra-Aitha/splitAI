const TYPES = new Set(['house', 'car', 'trip', 'savings']);

export function normalizeGoals(data) {
  if (!Array.isArray(data?.goals)) throw new Error('The saved goals could not be read. Try refreshing.');
  const ids = new Set();
  return data.goals.map((g) => {
    if (!g || typeof g.id !== 'string' || !g.id || ids.has(g.id) || !TYPES.has(g.type) || typeof g.name !== 'string' ||
        !Number.isSafeInteger(g.targetCents) || g.targetCents <= 0 || !Number.isSafeInteger(g.savedCents) || g.savedCents < 0 ||
        (g.targetDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(g.targetDate))) throw new Error('The saved goals need a refresh before they can be shown.');
    ids.add(g.id);
    return { id: g.id, type: g.type, name: g.name, target: g.targetCents, saved: g.savedCents, date: g.targetDate };
  });
}

export function goalPercent(goal) {
  const percent = BigInt(goal.saved) * 100n / BigInt(goal.target);
  return Number(percent > 100n ? 100n : percent);
}

export function createGoalStore({ request, onChange = () => {} }) {
  const state = { goals: [], status: 'idle', error: '', busy: false };
  const receipts = new Set();
  let revision = 0;
  let loadId = 0;
  function invalidate() { revision++; state.status = 'idle'; state.error = ''; onChange(); }
  async function load() {
    if (state.status === 'loading' || state.busy) return;
    const version = revision;
    const requestId = ++loadId;
    state.status = 'loading'; state.error = '';
    try {
      const goals = normalizeGoals(await request('/api/goals'));
      if (version === revision && requestId === loadId) { state.goals = goals; state.status = 'ready'; }
    } catch (error) {
      if (version === revision && requestId === loadId) { state.error = error.message; state.status = 'error'; }
    } finally {
      if (version !== revision && requestId === loadId) state.status = 'idle';
      onChange();
    }
  }
  async function save(path, body) {
    if (state.busy) return null;
    state.busy = true;
    revision++;
    loadId++;
    if (state.status === 'loading') state.status = 'idle';
    let receipt;
    try {
      receipt = await request(path, { method: 'POST', body });
      const version = revision;
      // A replay receipt can predate later movements. Always read canonical
      // state before changing progress or starting a celebratory animation.
      const goals = normalizeGoals(await request('/api/goals'));
      if (version !== revision) throw new Error('Your goals changed during refresh. Retry to read the current saved state.');
      state.goals = goals; state.status = 'ready'; state.error = '';
      const firstReceipt = !!receipt.movement && !receipts.has(receipt.movement.id);
      if (receipt.movement) receipts.add(receipt.movement.id);
      return { receipt, firstReceipt };
    } catch (error) {
      if (receipt) throw new Error(`Saved on the server, but the current goals could not be refreshed. Retry safely with this form. ${error.message}`);
      throw error;
    } finally { state.busy = false; onChange(); }
  }
  return { state, load, save, invalidate };
}
