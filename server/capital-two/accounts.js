import { HttpError } from '../http.js';
import { provisionBankAccount } from '../banking/provision.js';

export async function ownedAccount(db, userId, id) {
  const { rows: [account] } = await db.query(`SELECT id, kind, account_type AS type, provider_account_id AS reference
    FROM bank_accounts WHERE id = $1 AND user_id = $2 AND provider = 'nessie'
      AND account_type IN ('Checking', 'Credit Card') AND provider_account_id IS NOT NULL`, [id, userId]);
  if (!account) throw new HttpError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Choose one of your connected bank accounts.');
  return account;
}

// B12 owns provisioning and sharing consent. Opening the bank never links
// accounts to Split; only B12's explicit Connect / Allow action does that.
export async function ensureAccounts(dependencies, userId) {
  await provisionBankAccount(dependencies, userId);
}
