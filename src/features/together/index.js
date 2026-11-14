export function createTogether({ root, state, demo, icon, money, esc, heading, avatar, stack, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go, tx }) {
  function ticket() {
    const names = demo.draft.people;
    let share = Math.floor(demo.draft.cents / names.length);
    return `<div class="expense-ticket"><div class="ticket-top"><div class="ticket-kicker"><span class="eyebrow">Ready when you are</span><span class="pending-label">Not saved yet</span></div><div class="ticket-amount display money">${money(demo.draft.cents)}</div><h3>${esc(demo.draft.merchant)}</h3><span class="small muted">${esc(demo.draft.category)} · Paid by you</span></div><div class="ticket-middle"><div class="math-line small"><span class="muted">Split equally in</span><strong>Puffton 4</strong></div><div class="split-equation"><div class="split-people">${names.map((n, i) => `<div class="split-person">${avatar(n)}<span>${n === 'Maya' ? 'You' : n}</span><strong class="money">${money(share + (i === 0 ? demo.draft.cents - share * names.length : 0))}</strong></div>`).join('')}</div><button type="button" class="text-button cursor-interaction" data-action="edit-split">Edit</button></div><div class="ticket-actions"><button type="button" class="primary cursor-interaction" data-action="confirm-expense">${icon('check')}Confirm expense</button><button type="button" class="secondary cursor-interaction" data-action="discard">Discard</button></div></div><div class="ticket-foot">${icon('shield-check')}Adds a shared expense. No money will be transferred.</div></div>`;
  }
  function groups() {
    if (state.group) return ledger(state.group);
    return (
      heading(
        'Your groups',
        'Good company. Clear tabs.',
        'The shared stuff, without the “you still owe me” text.',
      ) +
      `<div class="group-list"><section class="group-large"><div class="group-title"><span class="group-picture">${icon('house')}</span><div><h2>Puffton 4</h2><p class="small muted">Roommates · 4 people</p></div>${stack()}</div><div class="group-summary"><div><div class="display money">${money((state.settled ? 6450 : 4650) + (state.logged ? demo.draft.cents - shareFor('Maya') : 0))}</div><p class="small muted">you’re owed, after your share</p></div><div class="group-actions"><button type="button" class="secondary cursor-interaction" data-action="puffton">View ledger</button><button type="button" class="primary cursor-interaction" data-action="settle">${state.settled ? 'View payment' : 'Settle up'}${icon('arrow-right')}</button></div></div><div class="group-caption"><span>Rent & utilities split 4 ways</span><span>${state.settled ? 'Your share is paid · 2 payments pending' : '7 IOUs simplified to 3 transfers'}</span></div></section><section class="group-large" style="border-radius:8px 24px 24px 24px"><div class="group-title"><span class="group-picture trip">${icon('luggage')}</span><div><h2>Boston weekend</h2><p class="small muted">Nov 20–22 · 3 people</p></div>${stack(['Maya', 'Sam', 'Priya'])}</div><div class="group-summary"><div><div class="display money">$642 <small class="muted">of $1,200</small></div><p class="small muted">Shared trip budget · $400 each</p></div><button type="button" class="secondary cursor-interaction" data-action="boston">Open trip ${icon('arrow-right')}</button></div><div class="trip-meter" role="progressbar" aria-label="Trip budget used" aria-valuemin="0" aria-valuemax="1200" aria-valuenow="642"><span></span></div><div class="group-caption" style="border:0;padding:0;margin-top:9px"><span>54% of the trip budget used</span><span>$558 still unplanned</span></div></section></div><div class="insight">${icon('heart-handshake')}<div><div class="insight-label">Everyone gets a say</div><p>Each person approves their own payment. A group balance never gives Split permission to move money.</p></div></div>`
    );
  }
  function ledger(group) {
    const trip = group === 'boston';
    return `<button type="button" class="back-button cursor-interaction" data-go="groups">${icon('arrow-left')}All groups</button><div class="ledger-title"><span class="group-picture ${trip ? 'trip' : ''}">${icon(trip ? 'luggage' : 'house')}</span><div><h1>${trip ? 'Boston weekend' : 'Puffton 4'}</h1><p class="small muted">${trip ? 'November 20–22 · $400 per person' : 'Roommates · 4 people · USD'}</p></div></div>${
      trip
        ? `<div class="balance-strip"><div class="available"><div class="label">Your remaining trip budget</div><div class="figure display money">$186<span class="cents">.00</span></div><p class="footnote">$214 of your $400 share is already booked.</p></div><div class="balance-math"><div class="math-line"><span class="muted">The whole trip</span><strong>$1,200.00</strong></div><div class="math-line"><span class="muted">Booked together</span><span>− $642.00</span></div><div class="math-line"><span>Still to plan</span><span>$558.00</span></div></div></div><div class="section-head"><h2>Booked & shared</h2><span class="tag">Split equally</span></div>${tx('A place in Cambridge', 'Priya paid · 3 people', '$510.00', 'bed-double')}${tx('Train tickets', 'Sam paid · 3 people', '$132.00', 'train-front')}<button type="button" class="primary cursor-interaction" data-action="trip-question" style="margin-top:22px">${icon('message-circle')}Check my trip budget</button><div class="insight">${icon('flag')}<div><div class="insight-label">Trip budget</div><p>We’ll flag the group at $960 — 80% of your shared budget. Everyone can see the same running total.</p></div></div>`
        : `<div class="ledger-note">${icon('git-pull-request-arrow')}<div><strong>Fewer payments. Same fair split.</strong><br><span class="muted">7 IOUs become 3 transfers. Only you can approve your payment.</span></div></div><div class="section-head"><h2>Your shared balances</h2><span class="small muted">After simplifying IOUs</span></div><div class="member-list">${[
            ['Sam', 2800 + (state.logged ? shareFor('Sam') : 0), 'owes you'],
            ['Priya', 3650 + (state.logged ? shareFor('Priya') : 0), 'owes you'],
            [
              'Alex',
              Math.abs((state.settled ? 0 : 1800) - (state.logged ? shareFor('Alex') : 0)),
              (state.settled ? 0 : 1800) - (state.logged ? shareFor('Alex') : 0) > 0
                ? 'you owe'
                : (state.settled ? 0 : 1800) - (state.logged ? shareFor('Alex') : 0) < 0
                  ? 'owes you'
                  : 'Settled',
            ],
          ]
            .map(
              ([n, c, label]) =>
                `<div class="member-row">${avatar(n)}<div><strong>${n}</strong><div class="small muted">${label}</div></div><strong class="money ${label === 'owes you' ? 'positive' : label === 'you owe' ? 'negative' : 'muted'}">${money(c)}</strong></div>`,
            )
            .join(
              '',
            )}</div><div class="section-head"><h2>Recent shared costs</h2><button type="button" class="text-button cursor-interaction" data-go="chat">Add a cost ${icon('plus')}</button></div>${state.logged ? tx(esc(demo.draft.merchant), 'You paid · ' + demo.draft.people.length + ' people', money(demo.draft.cents), 'utensils') : ''}${tx('Trader Joe’s', 'Priya paid · Nov 12', '$36.50', 'shopping-basket')}${tx('Utilities', 'Alex paid · Nov 10 · Recurring', '$72.00', 'plug')}${tx('Pizza night', 'You paid · Nov 8', '$56.00', 'pizza')}<div style="display:flex;justify-content:end;margin-top:22px"><button type="button" class="primary cursor-interaction" data-action="settle">${state.settled ? 'View payment' : 'Review my payment'}${icon('arrow-right')}</button></div>`
    }`;
  }
  function settlement() {
    if (state.settled) {
      paymentSuccess(false);
      return;
    }
    openModal(
      'Review payment',
      `<div class="modal-header"><div><div class="eyebrow">Puffton 4 · Your payment</div><h2>A clear tab with Alex.</h2></div>${closeButton}</div><div class="person">${avatar('Alex')}<div><strong>Alex Rivera</strong><p>Your roommate · Puffton 4</p></div></div><div class="amount-large display money">$18.00</div><div class="detail-row"><span class="muted">Why</span><strong>Your utilities share</strong></div><div class="detail-row"><span class="muted">From</span><span>Maya’s demo account · 0421</span></div><div class="detail-row"><span class="muted">Balance after payment</span><strong>${money(124800 - (state.logged ? demo.draft.cents : 0) - 1800)}</strong></div><div class="checks"><div class="check-row">${icon('check')}Alex is a member of your group</div><div class="check-row">${icon('check')}Amount matches what the ledger says you owe</div><div class="check-row">${icon('check')}Waiting for your approval</div></div><p>This settles your share. Sam and Priya approve their own payments separately.</p><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="close">Not now</button><button type="button" class="primary cursor-interaction" data-action="approve-payment">${icon('lock-keyhole')}Approve $18.00</button></div><div class="modal-fine">Sandbox payment · No real money will move</div>`,
    );
  }
  function paymentSuccess(animated = true) {
    openModal(
      'Payment complete',
      `<div class="modal-header"><span class="tag">Nessie sandbox</span>${closeButton}</div><div class="celebrate"><div class="success-orbit">${icon('check')}${animated ? Array.from({ length: 7 }, (_, i) => `<span class="paper-bit" style="--r:${i * 51}deg" aria-hidden="true"></span>`).join('') : ''}</div><h2>You and Alex? All square.</h2><p>Your $18.00 demo payment is complete.<br>One less tab between friends.</p></div><div class="detail-row"><span class="muted">Approved by</span><strong>You, just now</strong></div><div class="detail-row"><span class="muted">Group</span><span>Puffton 4</span></div><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="payment-log">View Guard log</button><button type="button" class="primary cursor-interaction" data-action="close">Lovely. Done.</button></div>`,
    );
  }
  function editSplit() {
    openModal(
      'Edit expense',
      `<div class="modal-header"><div><div class="eyebrow">Before you confirm</div><h2>Make it your split.</h2></div>${closeButton}</div><form id="sp-edit-form"><label class="field">Merchant<input name="merchant" required maxlength="60" value="${esc(demo.draft.merchant)}"></label><div class="field-grid"><label class="field">Total, USD<input name="amount" type="number" min="0.01" max="9999.99" step="0.01" required value="${(demo.draft.cents / 100).toFixed(2)}"></label><label class="field">Category<select name="category">${['Food & drink', 'Getting around', 'Just for fun', 'Groceries'].map((n) => `<option ${n === demo.draft.category ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div><p style="margin:13px 0 5px">Split equally with members of Puffton 4</p>${['Maya', 'Sam', 'Priya'].map((n) => `<label class="check-label"><input type="checkbox" name="person" value="${n}" ${demo.draft.people.includes(n) ? 'checked' : ''} ${n === 'Maya' ? 'disabled' : ''}>${n === 'Maya' ? 'You · paid the full amount' : n}</label>`).join('')}<div id="sp-edit-error" class="error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="close">Cancel</button><button type="submit" class="primary cursor-interaction">Update preview</button></div><div class="modal-fine">Nothing is saved until you confirm the expense.</div></form>`,
    );
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.filter) {
      state.filter = b.dataset.filter;
      render();
      persist();
      return;
    }
    switch (b.dataset.action) {
      case 'puffton':
        state.page = 'groups';
        state.group = 'puffton';
        render();
        persist();
        break;
      case 'boston':
        state.page = 'groups';
        state.group = 'boston';
        render();
        persist();
        break;
      case 'settle':
        settlement();
        break;
      case 'approve-payment':
        state.settled = true;
        render();
        persist();
        paymentSuccess();
        announce('Your $18 demo payment to Alex is complete.');
        break;
      case 'payment-log':
        closeModal();
        go('guard');
        break;
      case 'edit-split':
        editSplit();
        break;
      case 'confirm-expense':
        if (state.logged) break;
        state.logged = true;
        demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
        demo.draftVisible = false;
        render();
        persist();
        toast('Expense saved. Everyone has the same numbers.');
        break;
      case 'discard':
        demo.draftVisible = false;
        demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
        render();
        toast('Preview discarded. Nothing was saved.');
        break;
    }
  });
  function handleExpenseForm(form, fd) {
    if (form.id !== 'sp-edit-form') return;
      const amount = Math.round(Number(fd.get('amount')) * 100),
        selected = ['Maya', ...fd.getAll('person').filter((n) => n !== 'Maya')];
      if (
        !fd.get('merchant')?.trim() ||
        amount < 1 ||
        !Number.isFinite(amount) ||
        selected.length < 2
      ) {
        root.querySelector('#sp-edit-error').textContent =
          'Add a merchant, a positive amount, and at least one other person.';
        return;
      }
      demo.draft = {
        ...demo.draft,
        merchant: String(fd.get('merchant')).trim(),
        cents: amount,
        people: selected,
        category: String(fd.get('category')),
      };
      closeModal();
      demo.draftVisible = true;
      demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
      render();
      announce('Expense preview updated. Not saved yet.');
  }

  return { groups, ticket, handleExpenseForm };
}
