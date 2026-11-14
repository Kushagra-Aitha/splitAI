import test from 'node:test';
import assert from 'node:assert/strict';
import {explanationStatements,createChargeExplainer} from '../ledger/explanations.js';
const id='11111111-1111-4111-8111-111111111111';
test('expense explanations contain exact shares and do not claim expense-level settlement',()=>{
 const statements=explanationStatements({type:'expense',amountCents:4200,merchant:"Antonio's",payerName:'Ava',groupName:'Home',date:'Nov 14',method:'Credit card',yourShareCents:1400,shares:[{displayName:'Ben',cents:1400}]});
 assert.match(statements.charge,/\$42.00/);assert.match(statements.yourShare,/\$14.00/);assert.match(statements.status,/group balances/);
 assert.throws(()=>explanationStatements({amountCents:1.2}));
});
test('explanations enforce membership and provide facts when Gemini is unavailable',async()=>{
 let calls=0;
 const denied=createChargeExplainer({query:async()=>({rows:[]})});
 await assert.rejects(denied({actor:{userId:id},params:{id},body:{itemId:id,type:'settlement'}}),e=>e.status===404);
 const explain=createChargeExplainer({explain:async()=>{throw Error('quota');},query:async()=>({rows:++calls===1?[{name:'Home'}]:[{amountCents:1500,payerName:'Ava',payeeName:'Ben',status:'pending',date:'2026-11-14',method:'Checking'}]})});
 const result=await explain({actor:{userId:id},params:{id},body:{itemId:id,type:'settlement'}});
 assert.equal(result.explanationSource,'template');assert.match(result.answer,/\$15.00/);assert.match(result.answer,/awaiting verification/);
});
