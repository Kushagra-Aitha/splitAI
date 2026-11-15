import { preserveFocus } from '../../lib/focus.js';

export function createAskPanel({ root, icon, icons, renderChat }) {
  const layer = root.ownerDocument.createElement('div');
  layer.className = 'ask-layer'; layer.hidden = true;
  layer.innerHTML = `<div class="ask-backdrop" data-ask-close></div><section id="sp-ask-panel" class="ask-panel" role="dialog" aria-modal="true" aria-labelledby="sp-ask-panel-title">
    <header class="ask-panel-header"><div><span class="eyebrow">A little help, anywhere</span><h2 id="sp-ask-panel-title">Ask Split</h2></div><button type="button" class="icon-button" data-ask-close aria-label="Close Ask Split">${icon('x')}</button></header>
    <div class="ask-panel-body"></div></section>`;
  root.querySelector('.shell').append(layer);
  const panel = layer.querySelector('section'), body = layer.querySelector('.ask-panel-body');
  let returnTo, previousOverflow;
  const isOpen = () => !layer.hidden;
  const modalOpen = () => !!root.querySelector('#sp-modal-root').children.length;
  function background(inert) {
    for (const element of root.querySelectorAll('.main, .book-header, .bottom-nav, .ask-fab')) element.inert = inert;
  }
  function refresh() {
    if (!isOpen()) return;
    const oldThread = body.querySelector('.chat-thread');
    const nearBottom = !oldThread || oldThread.scrollHeight - oldThread.scrollTop - oldThread.clientHeight < 80;
    const scrollTop = oldThread?.scrollTop || 0;
    preserveFocus(body, () => { body.innerHTML = renderChat(); icons(); });
    const thread = body.querySelector('.chat-thread');
    if (thread) thread.scrollTop = nearBottom ? thread.scrollHeight : scrollTop;
  }
  function open() {
    if (modalOpen()) return;
    if (!isOpen()) {
      returnTo = root.ownerDocument.activeElement;
      previousOverflow = root.ownerDocument.documentElement.style.overflow;
      layer.hidden = false; background(true);
      root.ownerDocument.documentElement.style.overflow = 'hidden';
    }
    root.querySelector('[data-ask-open]')?.setAttribute('aria-expanded', 'true');
    refresh(); body.querySelector('#sp-chat-input')?.focus({ preventScroll: true });
  }
  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    layer.hidden = true; body.replaceChildren(); panel.inert = false; background(modalOpen());
    root.ownerDocument.documentElement.style.overflow = previousOverflow;
    root.querySelector('[data-ask-open]')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && returnTo?.isConnected && !returnTo.closest('[inert]')) returnTo.focus({ preventScroll: true });
  }
  layer.addEventListener('click', (event) => { if (event.target.closest('[data-ask-close]') && !modalOpen()) close(); });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-ask-open]')) { open(); return; }
    if (isOpen() && panel.contains(event.target) && event.target.closest('[data-go], [data-group-id], [data-page]')) {
      close({ restoreFocus: false }); root.querySelector('#sp-view h1')?.focus({ preventScroll: true });
    }
  }, true);
  root.addEventListener('keydown', (event) => {
    if (!isOpen() || modalOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length && !element.closest('[inert]'));
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);
  return { open, close, refresh, isOpen, clear() { close({ restoreFocus: false }); body.replaceChildren(); } };
}
