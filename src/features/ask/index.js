export function createAsk({ root, state, demo, icon, money, esc, heading, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, ticket, blockCard }) {
  function chat() {
    const initialBubble = state.logged
      ? `<div class="user-message">${esc(`Spent ${money(demo.draft.cents)} at ${demo.draft.merchant}. Split with ${demo.draft.people.filter((n) => n !== 'Maya').join(' and ')}.`)}</div><div class="agent-message"><div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div><div class="saved-ticket"><div class="success-stamp">${icon('circle-check')}Saved. That’s one less thing to remember.</div><p style="margin-top:7px;font-size:12px">${esc(demo.draft.merchant)} · ${money(demo.draft.cents)} split ${demo.draft.people.length} ways.<br>Your share is <strong>${money(shareFor('Maya'))}</strong>. ${demo.draft.people.filter((n) => n !== 'Maya').join(' and ')} can see it in Puffton 4.</p></div></div>`
      : demo.draftVisible
        ? `<div class="user-message">${esc(`Spent ${money(demo.draft.cents)} at ${demo.draft.merchant}. Split with ${demo.draft.people.filter((n) => n !== 'Maya').join(' and ')}.`)}</div><div class="agent-message"><div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div><p>Pizza math, handled. Does this look right?</p>${ticket()}</div>`
        : `<div class="agent-message"><div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div><p>Tell me what you spent, or ask about your numbers.</p></div>`;
    return (
      heading(
        'Ask Split',
        'Money talk. Less awkward.',
        'Add a cost, make a plan, or clear up who owes what.',
      ) +
      `<div class="chat-thread">${initialBubble}${demo.messages.map((m) => (m.kind === 'user' ? `<div class="user-message">${esc(m.text)}</div>` : m.kind === 'blocked' ? `<div class="agent-message"><div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div>${blockCard()}</div>` : `<div class="agent-message"><div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div>${m.html || `<p>${esc(m.text)}</p>`}</div>`)).join('')}</div><div class="composer-area"><div class="chips"><button type="button" class="chip cursor-interaction" data-action="trip-question">${icon('luggage')}Can I afford Boston?</button><button type="button" class="chip cursor-interaction" data-action="receipt">${icon('scan-line')}Try a receipt</button><button type="button" class="chip cursor-interaction" data-action="chat-attack">${icon('shield-alert')}See Guard block a note</button></div><form class="composer" id="sp-chat-form"><button type="button" class="icon-button cursor-interaction" data-action="upload" aria-label="Attach receipt photo">${icon('paperclip')}</button><label for="sp-chat-input" class="sr-only">Message Split</label><input id="sp-chat-input" name="message" placeholder="Tell me about it…" autocomplete="off" maxlength="500"><button type="submit" class="icon-button send cursor-interaction" aria-label="Send message">${icon('arrow-up')}</button></form><p class="chat-footnote">Split can suggest. You confirm every change. Numbers come from your ledger.</p></div>`
    );
  }
  function receipt(photo) {
    openModal(
      'Receipt preview',
      `<div class="modal-header"><div><div class="eyebrow">${photo ? 'Your photo' : 'Sample receipt'}</div><h2>The little paper trail.</h2></div>${closeButton}</div>${photo ? '<img class="photo-preview" id="sp-photo-preview" alt="Your selected receipt">' : `<div class="receipt-sample"><div class="display">ANTONIO’S</div><p>Amherst, MA · Nov 13, 2026</p><div class="math-line"><span>Pizza & drinks</span><span>$42.00</span></div><div class="math-line total"><span>TOTAL</span><span>$42.00</span></div></div>`}<p>${photo ? 'Check the photo and enter the amount below. This design preview does not scan uploaded photos.' : 'Split found a total of $42.00 in this sample. Check the details before adding it.'}</p><form id="sp-receipt-form"><div class="field-grid"><label class="field">Merchant<input name="merchant" required maxlength="60" value="${photo ? '' : 'Antonio’s'}" placeholder="Merchant name"></label><label class="field">Total, USD<input name="amount" type="number" step="0.01" min="0.01" max="9999.99" required value="${photo ? '' : '42.00'}" placeholder="0.00"></label></div><div class="tag">Puffton 4 · You, Sam & Priya</div><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="upload">Choose photo</button><button type="submit" class="primary cursor-interaction">Review expense ${icon('arrow-right')}</button></div></form>`,
    );
    if (photo) root.querySelector('#sp-photo-preview').src = photo;
  }
  function tripQuestion() {
    const available = 38800 - (state.logged ? demo.draft.cents : 0) - (state.settled ? 1800 : 0);
    demo.messages.push(
      { kind: 'user', text: 'Can I afford the Boston weekend?' },
      {
        kind: 'agent',
        html: `<p>You have <strong>${money(available)} after upcoming bills</strong>. You’ve already booked $214 of your $400 trip share.</p><div class="expense-ticket"><div class="ticket-top"><div class="ticket-kicker"><span class="eyebrow">Boston weekend · Your share</span><span class="pending-label">Budget estimate</span></div><div class="ticket-amount display">$186.00</div><p class="small muted">Remaining in your trip budget</p></div><div class="ticket-middle"><div class="math-line"><span>Left after setting this aside</span><strong>${money(available - 18600)}</strong></div><p class="small muted" style="margin-top:11px">That’s before your other day-to-day spending. Keep a cushion that feels comfortable.</p><button type="button" class="text-button cursor-interaction" data-action="boston" style="margin-top:10px">See the trip budget ${icon('arrow-right')}</button></div></div>`,
      },
    );
    state.page = 'chat';
    render();
    persist();
    announce('Trip budget estimate is ready.');
  }
  function submitChat(text) {
    if (!text.trim()) return;
    const t = text.trim();
    if (/boston|afford|trip/i.test(t)) {
      tripQuestion();
      return;
    }
    demo.messages.push({ kind: 'user', text: t });
    if (/ignore previous|outside account|send.*500/i.test(t)) {
      state.blocked = true;
      demo.messages.push({ kind: 'blocked' });
    } else if (/owe|owes/i.test(t)) {
      demo.messages.push({
        kind: 'agent',
        text: `In Puffton 4, Sam owes you ${money(2800 + (state.logged ? shareFor('Sam') : 0))} and Priya owes you ${money(3650 + (state.logged ? shareFor('Priya') : 0))}.${state.settled ? ' You’re settled with Alex.' : ' You owe Alex $18.00.'} Everyone approves their own payment.`,
      });
    } else if (/\$?\d+(?:\.\d{1,2})?/.test(t) && !state.logged) {
      const amount = t.match(/\$?(\d+(?:\.\d{1,2})?)/);
      let cents = Math.round(Number(amount[1]) * 100);
      if (cents > 0 && cents <= 999999) {
        demo.draft.cents = cents;
        const merchant = t.match(/(?:at|for)\s+(.+?)(?:,|\.\s|\s+split|$)/i);
        demo.draft.merchant = merchant ? merchant[1].slice(0, 60) : 'Shared expense';
        demo.draftVisible = false;
        demo.messages.push({
          kind: 'agent',
          html: `<p>Here’s a preview. Check the amount and people before confirming.</p>${ticket()}`,
        });
      } else
        demo.messages.push({
          kind: 'agent',
          text: 'Enter an amount from $0.01 to $9,999.99 for this preview.',
        });
    } else {
      demo.messages.push({
        kind: 'agent',
        text: 'In this prototype, you can log an expense, ask who owes you, or check the Boston trip budget. Try “spent $42 at Antonio’s, split with Sam and Priya.”',
      });
    }
    render();
    persist();
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.action) {
      case 'trip-question':
        tripQuestion();
        break;
      case 'receipt':
        if (state.logged) {
          toast('This demo supports one new shared expense.');
          break;
        }
        receipt();
        break;
      case 'upload':
        if (state.logged) {
          toast('Your shared expense is already saved.');
          break;
        }
        root.querySelector('#sp-receipt-file').click();
        break;
    }
  });
  function handleAskForm(form, fd) {
    if (form.id === 'sp-chat-form') {
      submitChat(String(fd.get('message') || ''));

    } else if (form.id === 'sp-receipt-form') {
      demo.draft = {
        ...demo.draft,
        merchant: String(fd.get('merchant')).trim(),
        cents: Math.round(Number(fd.get('amount')) * 100),
        source: 'receipt',
        people: ['Maya', 'Sam', 'Priya'],
        category: 'Food & drink',
      };
      closeModal();
      state.page = 'chat';
      demo.draftVisible = true;
      render();
      persist();
    }
  }
  root.querySelector('#sp-receipt-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      toast('Choose an image of your receipt.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => receipt(reader.result);
    reader.readAsDataURL(f);
    e.target.value = '';
  });

  return { chat, handleAskForm };
}
