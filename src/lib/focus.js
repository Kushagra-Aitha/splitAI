// Replacing a view should not move an active field's cursor or drop keyboard
// focus when the same control still exists. Dialogs live outside that view.
export function preserveFocus(root, render) {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const id = active?.id;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  render();
  if (!id || active.isConnected) return;
  const replacement = doc.getElementById(id);
  if (!replacement || !root.contains(replacement) || replacement.matches(':disabled') || replacement.closest('[inert]')) return;
  replacement.focus({ preventScroll: true });
  if (typeof start === 'number' && typeof end === 'number' && replacement.setSelectionRange) replacement.setSelectionRange(start, end);
}
