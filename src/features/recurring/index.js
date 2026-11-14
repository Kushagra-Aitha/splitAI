import { apiRequest } from '../../api/session.js';
import { subscribeFinancialChanges } from '../../api/financial-state.js';
import { centsToUsdText, usdToCents } from '../../lib/money.js';

export function createRecurringSplits({ root, state, esc, money, icons, openModal, closeModal, closeButton,
  toast, draftTicket, registerReview, openGroup }) {
  const path = '/api/recurring-splits';
  let listed = null;
  let loading = null;
  let loadError = false;

  function refresh() {
    if (loading || !root.querySelector('[data-recurring-host]')) return;
    loading = apiRequest(path);
    loading.then((data) => { listed = data; loadError = false; }, () => { loadError = true; })
      .finally(() => { loading = null; paint(); });
  }

  function paint() {
    for (const host of root.querySelectorAll('[data-recurring-host]')) {
      const groupId = host.dataset.recurringHost;
      const visible = (item) => !groupId || item.groupId === groupId;
      const rules = listed?.rules.filter(visible) ?? [];
      const drafts = listed?.drafts.filter(visible) ?? [];
      host.innerHTML = `<h2>Recurring splits</h2>
        ${loadError ? '<p role="alert">Couldn’t load recurring splits. <button type="button" class="text-button" data-recurring-action="refresh">Retry</button></p>' : ''}
        ${drafts.map((draft) => `<p><strong>${esc(draft.merchant)} · ${money(draft.totalCents)}</strong> · ${esc(draft.groupName)}
          <button type="button" class="primary" data-recurring-action="review" data-id="${esc(draft.id)}">Review split</button></p>`).join('')}
        ${rules.map((rule) => `<div class="detail-row"><span><strong>${esc(rule.payee)}</strong> · ${esc(rule.groupName)} · ${esc(rule.mode)}
          ${rule.paused ? ' · Paused' : rule.scheduleStatus !== 'active' ? ' · Payment inactive' : ''}</span>
          <span><button type="button" class="text-button" data-recurring-action="${rule.paused ? 'resume' : 'pause'}" data-id="${esc(rule.id)}">${rule.paused ? 'Resume' : 'Pause'}</button>
          <button type="button" class="text-button" data-recurring-action="delete" data-id="${esc(rule.id)}">Delete</button></span></div>`).join('')}
        ${!rules.length && !drafts.length && !loadError ? `<p class="small muted">${listed ? 'No recurring splits yet.' : 'Loading recurring splits…'}</p>` : ''}`;
    }
    icons();
  }

  let pageKey = '';
  function afterRender() {
    const key = root.querySelector('[data-recurring-host]') ? `${state.page}:${state.group ?? ''}` : '';
    if (key) paint();
    if (key && key !== pageKey) refresh();
    pageKey = key;
  }

  subscribeFinancialChanges(refresh);
  window.addEventListener('focus', refresh);
  window.setInterval(refresh, 20_000);

  async function openRule(button) {
    button.disabled = true;
    const groupId = button.dataset.group;
    const transactionId = button.dataset.transaction;
    const query = new URLSearchParams(transactionId ? { transaction: transactionId } : {});
    try {
      const data = await apiRequest(`${path}?${query}`);
      if (!button.isConnected) return;
      const selected = groupId || data.previous?.groupId;
      if (!selected) throw new Error('The original split is no longer available.');
      const schedules = data.schedules.filter((schedule) => !data.rules.some((rule) => rule.scheduleId === schedule.id));
      if (!schedules.length) {
        toast('Set up a monthly payment in Capital Two and share its account with Split first.');
        return;
      }
      const { group, members } = await apiRequest(`/api/groups/${encodeURIComponent(selected)}`);
      if (!button.isConnected) return;
      const previous = data.previous?.shares;
      openModal('Recurring split', `<h2>Split a recurring payment</h2>${closeButton}<p>${esc(group.name)}</p>
        <form id="sp-recurring-rule" data-group="${esc(group.id)}">
          <label class="field">Capital Two payment<select name="scheduleId">${schedules.map((schedule) => `
            <option value="${esc(schedule.id)}" ${schedule.id === data.previous?.scheduleId ? 'selected' : ''}>${esc(schedule.payee)} · ${money(schedule.amountCents)} · ${schedule.accountKind === 'credit_card' ? 'Card' : 'Checking'}</option>`).join('')}</select></label>
          <label class="field">Split method<select name="mode"><option value="equal">Equal</option>
            <option value="exact" ${previous ? 'selected' : ''}>Exact amounts (USD)</option><option value="percentage">Percentage</option></select></label>
          <fieldset><legend>People</legend>${members.map((member) => `<div>
            <label class="check-label"><input name="participant" type="checkbox" value="${esc(member.userId)}" ${!previous || Object.hasOwn(previous, member.userId) ? 'checked' : ''}>${esc(member.displayName)}</label>
            <label class="field" data-rule-value><span></span><input name="share-${esc(member.userId)}" inputmode="decimal" value="${Object.hasOwn(previous ?? {}, member.userId) ? centsToUsdText(previous[member.userId]) : ''}"></label>
          </div>`).join('')}</fieldset>
          <p role="alert"></p><button class="primary" type="submit">Save rule</button></form>`);
      updateInputs(root.querySelector('#sp-recurring-rule'));
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }

  function updateInputs(form) {
    const mode = form.elements.mode.value;
    for (const field of form.querySelectorAll('[data-rule-value]')) {
      field.hidden = mode === 'equal' || !field.parentElement.querySelector('[name="participant"]').checked;
      field.querySelector('span').textContent = mode === 'exact' ? 'Share in USD' : 'Share in %';
      field.querySelector('input').disabled = field.hidden;
      field.querySelector('input').required = !field.hidden;
    }
  }

  async function save(form, fields) {
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const errorHost = form.querySelector('[role="alert"]');
    button.disabled = true;
    try {
      const mode = fields.get('mode');
      const participantIds = fields.getAll('participant');
      const values = mode === 'equal' ? undefined : Object.fromEntries(participantIds.map((id) =>
        [id, usdToCents(fields.get(`share-${id}`).trim(), { allowZero: true })]));
      await apiRequest(path, { method: 'POST', body: {
        groupId: form.dataset.group, scheduleId: fields.get('scheduleId'), participantIds, allocation: { mode, values },
      } });
      if (form.isConnected) closeModal();
      toast('Recurring split saved.');
      refresh();
    } catch (error) { errorHost.textContent = error.message; }
    finally { button.disabled = false; }
  }

  root.addEventListener('change', ({ target }) => {
    if (target.form?.id === 'sp-recurring-rule') updateInputs(target.form);
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-recurring-action]');
    if (!button) return;
    const { recurringAction: action, id } = button.dataset;
    if (action === 'create') return openRule(button);
    if (action === 'refresh') return refresh();
    if (action === 'review') {
      const draft = listed?.drafts.find((item) => item.id === id);
      if (!draft) return;
      registerReview(draft, { discardLabel: 'Close', onConfirmed: () => {
        if (listed) listed.drafts = listed.drafts.filter((item) => item.id !== draft.id);
        openGroup(draft.groupId);
        refresh();
      } });
      openModal('Review recurring split', `<h2>Review recurring split</h2>${closeButton}${draftTicket(draft)}`);
      return;
    }
    button.disabled = true;
    try {
      await apiRequest(`${path}/${encodeURIComponent(id)}`, { method: 'POST', body: { action } });
      refresh();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });

  return { afterRender, handleForm(form, fields) {
    if (form.id !== 'sp-recurring-rule') return false;
    void save(form, fields);
    return true;
  } };
}
