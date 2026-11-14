// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { bankingHandlers } from './banking/handlers.js';

export const handlers = Object.freeze({
  ...bankingHandlers,
});
