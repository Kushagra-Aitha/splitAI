import { randomUUID } from 'node:crypto';
import { NessieError } from '../../lib/nessie.js';

export function fakeCapitalProvider() {
  const accounts = new Map(), customers = new Map(), merchants = new Map(), transactions = new Map();
  let createCalls = 0, loseNextCreate = false, failSettle = false;
  const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const balance = (account) => ({ ...account, available_cents: account.type === 'Credit Card'
    ? account.credit_limit_cents - account.balance_cents - account.pending_debits_cents : account.balance_cents - account.pending_debits_cents });
  const request = async (path, { method = 'GET', body } = {}) => {
    const url = new URL(path, 'https://bank.test'), route = url.pathname;
    if (route === '/customers' && method === 'POST') { const customer = { id: id('cus') }; customers.set(customer.id, customer); return { data: customer }; }
    let match = route.match(/^\/customers\/([^/]+)\/accounts$/);
    if (match) {
      if (method === 'GET') return { data: { items: [...accounts.values()].filter((account) => account.customer_id === match[1]).map(balance) } };
      const account = { id: id('acct'), type: body.type, nickname: body.nickname, customer_id: match[1],
        balance_cents: body.balance_cents, credit_limit_cents: body.credit_limit_cents, pending_debits_cents: 0, account_number: '00001234' };
      accounts.set(account.id, account); return { data: balance(account) };
    }
    if (route === '/merchants') {
      if (method === 'GET') return { data: { items: [...merchants.values()] } };
      const merchant = { id: id('merch'), ...body }; merchants.set(merchant.id, merchant); return { data: merchant };
    }
    match = route.match(/^\/accounts\/([^/]+)(?:\/(transactions|purchases|withdrawals|transfers|deposits))?$/);
    if (match) {
      const account = accounts.get(match[1]); if (!account) throw new NessieError(404, {}, route);
      if (!match[2]) return { data: balance(account) };
      if (match[2] === 'transactions') return { data: { items: [...transactions.values()].filter((tx) => tx.payer_id === account.id || tx.payee_id === account.id).reverse() } };
      createCalls++;
      if (match[2] !== 'deposits' && body.amount_cents > balance(account).available_cents) throw new NessieError(422, { type: 'insufficient_funds' }, route);
      const transaction = { id: id('txn'), kind: { purchases: 'purchase', withdrawals: 'withdrawal', transfers: 'transfer', deposits: 'deposit' }[match[2]],
        status: 'pending', payer_id: account.id, ...body, created_at: new Date().toISOString() };
      if (transaction.kind !== 'deposit') account.pending_debits_cents += body.amount_cents;
      transactions.set(transaction.id, transaction);
      if (loseNextCreate) { loseNextCreate = false; const error = new Error('Synthetic lost response'); error.name = 'TimeoutError'; throw error; }
      return { data: { ...transaction } };
    }
    match = route.match(/^\/transactions\/([^/]+)(\/settle)?$/);
    if (match) {
      const transaction = transactions.get(match[1]); if (!transaction) throw new NessieError(404, {}, route);
      if (match[2] && transaction.status === 'pending') {
        if (failSettle) throw new NessieError(503, {}, route);
        const payer = accounts.get(transaction.payer_id), payee = accounts.get(transaction.payee_id);
        if (transaction.kind !== 'deposit') payer.pending_debits_cents -= transaction.amount_cents;
        payer.balance_cents += transaction.amount_cents * (transaction.kind === 'deposit' || payer.type === 'Credit Card' ? 1 : -1);
        if (payee) payee.balance_cents += transaction.amount_cents * (payee.type === 'Credit Card' ? -1 : 1);
        transaction.status = 'completed';
      }
      return { data: { ...transaction } };
    }
    throw new Error(`Unexpected fake provider route ${method} ${route}`);
  };
  return { request, accounts, transactions, get createCalls() { return createCalls; },
    loseCreateResponse() { loseNextCreate = true; }, failSettlement(value) { failSettle = value; } };
}
