import { HttpError } from '../http.js';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
export function explanationStatements(facts) {
  if (!Number.isSafeInteger(facts.amountCents) || facts.amountCents < 0) throw new HttpError(409,'INVALID_CHARGE_STATE','This charge needs review.');
  if (facts.type === 'settlement') return {
    payment:`${facts.payerName} approved ${money(facts.amountCents)} to ${facts.payeeName} in ${facts.groupName}.`,
    date:`Reviewed on ${facts.date}. Payment source: ${facts.method}.`,
    status: facts.status === 'posted' ? 'The bank posted this payment; the group debt was reduced once.' : facts.status === 'failed' ? 'The payment failed. It did not reduce the group debt.' : 'This payment is awaiting verification. It has not reduced the group debt.',
  };
  return {charge:`${facts.payerName} paid ${money(facts.amountCents)} for ${facts.merchant} in ${facts.groupName}.`,
    date:`Recorded on ${facts.date}. Payment source: ${facts.method}.`,
    split: facts.shares.map(s => `${s.displayName}: ${money(s.cents)}`).join('; ')+'.',
    yourShare:`Your share is ${money(facts.yourShareCents)}.`,
    status:'This split is confirmed. Settlements apply to group balances, rather than individual expense IDs. Splitting itself moved no money.'};
}
export function createChargeExplainer({ query, explain }) {
  return async ({actor,params,body}) => {
    if (!uuid.test(params.id) || !uuid.test(body?.itemId) || !['expense','settlement'].includes(body.type)) throw new HttpError(422,'INVALID_CHARGE','Choose an expense or settlement.');
    const {rows:[access]} = await query(`SELECT g.name FROM groups g JOIN group_members m ON m.group_id=g.id WHERE g.id=$1 AND m.user_id=$2 AND m.left_at IS NULL`,[params.id,actor.userId]);
    if (!access) throw new HttpError(404,'GROUP_NOT_FOUND','Group not found.');
    let facts;
    if (body.type === 'expense') {
      const {rows:[e]} = await query(`SELECT e.total_cents AS "amountCents",e.merchant,u.display_name AS "payerName",e.confirmed_at AS date,
        CASE WHEN a.kind='credit_card' THEN 'Credit card' WHEN a.kind='checking' THEN 'Checking debit card' ELSE 'Manual or cash expense' END AS method
        FROM expenses e JOIN users u ON u.id=e.created_by LEFT JOIN bank_accounts a ON a.id=e.bank_account_id
        WHERE e.id=$1 AND e.group_id=$2 AND e.status='confirmed'`,[body.itemId,params.id]);
      if (!e) throw new HttpError(404,'CHARGE_NOT_FOUND','Confirmed expense not found.');
      const {rows:shares} = await query(`SELECT s.user_id AS "userId",u.display_name AS "displayName",s.share_cents AS cents FROM expense_shares s JOIN users u ON u.id=s.user_id WHERE s.expense_id=$1 ORDER BY u.id`,[body.itemId]);
      if (shares.some(s=>!Number.isSafeInteger(s.cents)||s.cents<0)) throw new HttpError(409,'INVALID_CHARGE_STATE','These shares need review.');
      facts={...e,shares,yourShareCents:shares.find(s=>s.userId===actor.userId)?.cents??0};
    } else {
      const {rows:[s]} = await query(`SELECT s.amount_cents AS "amountCents",s.status,s.created_at AS date,payer.display_name AS "payerName",payee.display_name AS "payeeName",'Checking' AS method
        FROM settlements s JOIN users payer ON payer.id=s.payer_user_id JOIN users payee ON payee.id=s.payee_user_id
        WHERE s.id=$1 AND s.group_id=$2 AND s.status IN ('pending','posted','failed')`,[body.itemId,params.id]);
      if (!s) throw new HttpError(404,'CHARGE_NOT_FOUND','Settlement not found.'); facts=s;
    }
    facts={...facts,type:body.type,groupName:access.name,date:new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'America/New_York'}).format(new Date(facts.date))};
    const statements=explanationStatements(facts); let answer,source='template';
    if (explain) try { answer=await explain(statements);source='gemini'; } catch { /* Exact code-generated facts remain available without model quota. */ }
    return {type:'answer',intent:'charge_explanation',answer:answer||Object.values(statements).join(' '),explanationSource:source,facts};
  };
}
