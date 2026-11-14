// B10 · One avatar for every person in Split: initials on a colour picked
// from their user ID, so the same person looks the same on every page.

export const AVATAR_TONES = 6;

export function initialsFor(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

/** Stable 0…AVATAR_TONES-1 from any ID string (FNV-1a). */
export function toneFor(id = '') {
  let hash = 0x811c9dc5;
  for (const char of String(id)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_TONES;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Avatar markup. `person` needs `userId` (or `id`) and `displayName` (or `name`).
 * Sizes: 'sm' (24px), 'md' (34px, default), 'lg' (44px).
 */
export function avatarHtml(person = {}, { size = 'md', label = true } = {}) {
  const name = person.displayName ?? person.name ?? '';
  const id = person.userId ?? person.id ?? name;
  const aria = label && name ? ` role="img" aria-label="${escapeHtml(name)}"` : ' aria-hidden="true"';
  return `<span class="avatar avatar-${size} tone-${toneFor(id)}"${aria}>${escapeHtml(initialsFor(name))}</span>`;
}

/** Overlapping avatars for a list of people (shows up to `max`, then +N). */
export function avatarStackHtml(people = [], { max = 4, size = 'sm' } = {}) {
  const shown = people.slice(0, max).map((person) => avatarHtml(person, { size })).join('');
  const more = people.length > max ? `<span class="avatar avatar-${size} avatar-more" aria-label="${people.length - max} more">+${people.length - max}</span>` : '';
  return `<span class="avatar-group">${shown}${more}</span>`;
}
