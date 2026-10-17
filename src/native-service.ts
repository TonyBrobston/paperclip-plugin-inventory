import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './db.js';
import { InputError } from './errors.js';
import { object, text } from './extraction.js';
import { parseQuantity } from './quantity.js';
import { parseEnabledVendors } from './config.js';
import { appendEntry } from './ledger.js';
import { parsePartRef } from './parts.js';

export interface NativeActor { type: 'user'|'agent'; id: string; companyId: string; }
interface Policy { enabledVendors: string[]; approvalMode: 'all'|'threshold'; absoluteThreshold: number; percentThreshold: number; approverUserIds: string[]; allowSelfApproval: boolean; }
interface CountLine { partId:string; expected:number; counted:number; ledgerRevision:string; }
const uuid = (value:unknown,label:string) => { const v=text(value,label); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new InputError(`${label} must be a UUID.`); return v; };
const json = (value:unknown) => JSON.stringify(value);
const quantity = (value:unknown,label:string,nonnegative=true) => { const n=parseQuantity(value,{label}); if(nonnegative && n<0) throw new InputError(`${label} cannot be negative.`); return n; };
const human = (actor:NativeActor) => { if(actor.type!=='user'||!actor.id) throw new InputError('An authenticated human is required.'); };
function validatePolicy(value:unknown):Policy {
 const p=object(value); const enabledVendors=parseEnabledVendors(p.enabledVendors);
 if(!['all','threshold'].includes(String(p.approvalMode))) throw new InputError('Approval mode must be all or threshold.');
 if(typeof p.allowSelfApproval!=='boolean') throw new InputError('Self approval policy must be boolean.');
 if(!Array.isArray(p.approverUserIds)||p.approverUserIds.length>100) throw new InputError('Approvers must be a list of human user IDs.');
 return {enabledVendors,approvalMode:p.approvalMode as Policy['approvalMode'],absoluteThreshold:quantity(p.absoluteThreshold,'Absolute threshold'),percentThreshold:quantity(p.percentThreshold,'Percent threshold'),approverUserIds:[...new Set(p.approverUserIds.map(v=>text(v,'Approver ID',200)))],allowSelfApproval:p.allowSelfApproval};
}
async function settings(client:PoolClient,lock=false) {
 const r=await client.query(`SELECT settings,revision::text FROM operational_settings WHERE singleton=true${lock?' FOR UPDATE':''}`);
 return {settings:r.rows[0].settings as Policy,revision:r.rows[0].revision as string};
}
async function audit(client:PoolClient,actor:NativeActor,operation:string,target:string,before:unknown,after:unknown,reason:string) {
 await client.query('INSERT INTO operational_audit(operation,target,before_value,after_value,reason,actor) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb)',[operation,target,json(before),json(after),reason,json(actor)]);
}
async function lockParts(client:PoolClient,ids:string[]) {
 await client.query('SELECT id FROM parts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
}
async function snapshot(client:PoolClient,partId:string) {
 const r=await client.query(`SELECT p.id AS "partId",COALESCE(sum(e.on_hand_delta),0)::text AS expected,COALESCE(max(e.id),0)::text AS "ledgerRevision"
 FROM parts p LEFT JOIN ledger_entries e ON e.part_id=p.id WHERE p.id=$1 GROUP BY p.id`,[partId]);
 if(!r.rows[0]) throw new InputError('Part was not found.');
 return {...r.rows[0],expected:Number(r.rows[0].expected)} as Omit<CountLine,'counted'>;
}
function needsApproval(policy:Policy,lines:CountLine[]) {
 return lines.some(l=>{const delta=Math.abs(l.counted-l.expected);return delta>0&&(policy.approvalMode==='all'||delta>policy.absoluteThreshold||(l.expected===0?delta>0:delta/Math.abs(l.expected)*100>policy.percentThreshold));});
}
function approver(actor:NativeActor,policy:Policy,submitter?:NativeActor) {
 human(actor);
 if(policy.approverUserIds.length&&!policy.approverUserIds.includes(actor.id)) throw new InputError('This human is not an authorized inventory approver.');
 if(!policy.allowSelfApproval&&submitter?.type===actor.type&&submitter.id===actor.id) throw new InputError('The submitter cannot approve their own count.');
}
function countLines(input:unknown,allowNegative=false):CountLine[] {
 if(!Array.isArray(input)||input.length<1||input.length>200) throw new InputError('A batch requires 1–200 count lines.');
 const rows=input.map(v=>{const l=object(v);const revision=text(String(l.ledgerRevision??''),'Ledger revision');if(!/^\d+$/.test(revision))throw new InputError('Ledger revision must be an integer.');return {partId:uuid(l.partId,'Part ID'),expected:quantity(l.expected,'Expected',false),counted:quantity(l.counted,'Counted',!allowNegative),ledgerRevision:revision};});
 if(new Set(rows.map(r=>r.partId)).size!==rows.length) throw new InputError('A part may appear only once in a batch.');
 return rows.sort((a,b)=>a.partId.localeCompare(b.partId));
}
async function ensureSnapshot(client:PoolClient,lines:CountLine[]) {
 await lockParts(client,lines.map(l=>l.partId));
 for(const line of lines) {const current=await snapshot(client,line.partId);if(current.ledgerRevision!==line.ledgerRevision||current.expected!==line.expected) throw new InputError('Stale stock snapshot. Preview and count again.');}
}
async function applyCount(db:DatabaseHandle,client:PoolClient,count:any,actor:NativeActor,reason:string) {
 const raw=await client.query('SELECT * FROM physical_count_lines WHERE count_id=$1 ORDER BY part_id',[count.id]);
 const lines=raw.rows.map(l=>({partId:l.part_id,expected:Number(l.expected),counted:Number(l.counted),ledgerRevision:String(l.ledger_revision)}));
 await ensureSnapshot(client,lines);
 await client.query("UPDATE physical_counts SET status='applying',decided_by=$2::jsonb,decided_at=now(),decision_reason=$3 WHERE id=$1",[count.id,json(actor),reason]);
 for(const l of raw.rows) {
  const delta=Number((Number(l.counted)-Number(l.expected)).toFixed(4)); if(!delta) continue;
  const result=await appendEntry(db,{part:{kind:'id',id:l.part_id},entryType:'adjustment',quantity:delta,reference:`count:${count.id}`,idempotencyScope:['count',count.id],countLineId:l.id,note:count.reason,createdBy:actor.id,provenance:{source:'physical_count',countId:count.id,countLineId:l.id,submitter:count.submitted_by,approver:actor,reason:count.reason,decisionReason:reason,policy:count.policy_snapshot,companyId:actor.companyId}},client);
  await client.query('UPDATE physical_count_lines SET ledger_entry_id=$2 WHERE id=$1',[l.id,result.entry.id]);
 }
 await client.query("UPDATE physical_counts SET status='applied' WHERE id=$1",[count.id]);
 return {countId:count.id,status:'applied',duplicate:false};
}
async function submitCount(db:DatabaseHandle,client:PoolClient,actor:NativeActor,input:Record<string,unknown>,allowNegative=false,forceApproval=false) {
 const lines=countLines(input.lines,allowNegative); const key=text(input.submissionKey,'Submission key'); const reason=text(input.reason,'Reason');
 const current=await settings(client,true);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`count:${key}`]);
 const old=await client.query('SELECT * FROM physical_counts WHERE submission_key=$1',[key]);
 const payload={lines,reason};
 if(old.rows[0]) {if(json(old.rows[0].payload)!==json(JSON.parse(json(payload)))) {
  // JSONB key ordering is not significant.
  const stored=old.rows[0].payload; if(stored.reason!==reason||json(stored.lines.map((l:any)=>[l.partId,l.expected,l.counted,l.ledgerRevision]))!==json(lines.map(l=>[l.partId,l.expected,l.counted,l.ledgerRevision])))throw new InputError('Submission key was already used with different counts.');
 }return {countId:old.rows[0].id,status:old.rows[0].status,duplicate:true};}
 await ensureSnapshot(client,lines);
 const result=await client.query(`INSERT INTO physical_counts(submission_key,reason,submitted_by,policy_snapshot,settings_revision,payload,status)
 VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,'pending') RETURNING *`,[key,reason,json(actor),json(current.settings),current.revision,json(payload)]);
 const count=result.rows[0];
 for(const l of lines)await client.query('INSERT INTO physical_count_lines(count_id,part_id,expected,counted,ledger_revision) VALUES($1,$2,$3,$4,$5)',[count.id,l.partId,l.expected,l.counted,l.ledgerRevision]);
 if(!forceApproval&&!needsApproval(current.settings,lines)) return applyCount(db,client,count,{...actor},'Applied automatically within configured discrepancy thresholds');
 return {countId:count.id,status:'pending',duplicate:false};
}
/** Durable credits include refreshed counts; caller holds the settings lock. */
export async function appliedRefundUnits(client:PoolClient,orderId:string,lineId:string):Promise<number> {
 const prefix=JSON.stringify(['bc-refund',orderId,lineId]).slice(0,-1)+',';
 const applied=await client.query(`WITH RECURSIVE refunds(root_key,id,status) AS (
  SELECT submission_key,id,status FROM physical_counts
  WHERE left(submission_key,length($1))=$1 AND right(submission_key,1)=']'
  UNION
  SELECT r.root_key,c.id,c.status FROM refunds r
  JOIN operational_audit a ON a.operation='refresh_refund_count' AND a.target=r.id::text
  JOIN physical_counts c ON c.submission_key=a.after_value->>'submissionKey'
 ) SELECT root_key FROM refunds WHERE status='applied'`,[prefix]);
 return Math.max(0,...applied.rows.map(row=>Number(JSON.parse(row.root_key)[3])));
}
/** Trusted domain callers share the same count policy and transaction. */
export async function submitAdjustmentBatch(db:DatabaseHandle,client:PoolClient,actor:NativeActor,deltas:{partId:string;quantity:number}[],submissionKey:string,reason:string,forceApproval=false):Promise<{countId:string;status:string;duplicate:boolean}> {
 await settings(client,true);
 const previous=await client.query('SELECT * FROM physical_counts WHERE submission_key=$1',[submissionKey]);
 if(previous.rows[0]) {
  const old=previous.rows[0];
  const actual=old.payload.lines.map((l:CountLine)=>[l.partId,Number((l.counted-l.expected).toFixed(4))]).sort();
  const requested=deltas.map(l=>[l.partId,l.quantity]).sort();
  if(old.reason!==reason)throw new InputError('Adjustment batch key was already used with a different reason.');
  const successor=await client.query("SELECT after_value->>'submissionKey' AS key FROM operational_audit WHERE operation='refresh_refund_count' AND target=$1 ORDER BY id DESC LIMIT 1",[old.id]);
  if(old.status==='rejected'&&successor.rows[0])return submitAdjustmentBatch(db,client,actor,deltas,successor.rows[0].key,reason,true);
  if(json(actual)!==json(requested))throw new InputError('Adjustment batch key was already used with different quantities.');
  return {countId:old.id,status:old.status,duplicate:true};
 }
 await lockParts(client,deltas.map(l=>l.partId));
 const lines=[];
 for(const delta of deltas){const snap=await snapshot(client,delta.partId);lines.push({...snap,counted:Number((snap.expected+delta.quantity).toFixed(4))});}
 return submitCount(db,client,actor,{lines,submissionKey,reason},true,forceApproval);
}
async function orderRows(client:PoolClient,orderId:string) {
 const order=await client.query('SELECT * FROM orders WHERE id=$1',[orderId]); if(!order.rows[0])throw new InputError('Order was not found.');
 const r=await client.query(`SELECT p.id AS "partId",p.vendor,p.vendor_part_number AS "vendorPartNumber",p.description,sum(l.quantity)::text AS ordered,
 max(l.unit_price)::text AS "unitCost",COALESCE((SELECT sum(e.quantity_delta) FROM ledger_entries e WHERE e.part_id=p.id AND e.reference=$2 AND e.entry_type='receipt'),0)::text AS received,
 COALESCE((SELECT sum(c.quantity) FROM order_short_closes c WHERE c.order_id=$1 AND c.part_id=p.id),0)::text AS closed
 FROM order_lines l JOIN parts p ON p.id=l.part_id WHERE l.order_id=$1 GROUP BY p.id ORDER BY p.id`,[orderId,order.rows[0].vendor_order_number]);
 const lines=[];for(const l of r.rows) lines.push({...l,ordered:Number(l.ordered),received:Number(l.received),closed:Number(l.closed),outstanding:Math.max(0,Number(l.ordered)-Number(l.received)-Number(l.closed)),...(await snapshot(client,l.partId))});
 return {order:order.rows[0],lines};
}
export async function executeNative(db:DatabaseHandle,actor:NativeActor,operation:string,input:Record<string,unknown>):Promise<Record<string,unknown>> {
 if(!actor.id||!actor.companyId||!['user','agent'].includes(actor.type))throw new InputError('Authenticated actor and company are required.');
 return db.transaction(async client=>{
  if(operation==='import_legacy_settings') {
   human(actor);const current=await settings(client,true);approver(actor,current.settings);
   const reason=text(input.reason,'Import reason');
   if(String(input.revision)!==current.revision)throw new InputError('Settings changed. Reload before importing.');
   const prior=await client.query("SELECT id FROM operational_audit WHERE operation='import_legacy_settings' LIMIT 1");
   if(prior.rowCount)throw new InputError('Legacy settings have already been imported. Use normal settings and part edits.');
   const next=validatePolicy(input.settings);
   if(!Array.isArray(input.parts)||input.parts.length>10000)throw new InputError('Legacy parts must be a list with at most 10000 entries.');
   const parts=input.parts.map(v=>{const p=object(v);if(typeof p.active!=='boolean')throw new InputError('Legacy active status must be boolean.');return {
    partId:uuid(p.partId,'Part ID'),reorderPoint:quantity(p.reorderPoint,'Reorder point'),targetQuantity:quantity(p.targetQuantity,'Target quantity'),
    location:p.location===''?'':text(p.location,'Location'),notes:p.notes===''?'':text(p.notes,'Notes',4000),active:p.active,
   };});
   if(new Set(parts.map(p=>p.partId)).size!==parts.length)throw new InputError('A legacy part may appear only once.');
   await lockParts(client,parts.map(p=>p.partId));
   for(const part of parts){const old=await client.query('SELECT * FROM parts WHERE id=$1',[part.partId]);if(!old.rows[0])throw new InputError('Legacy part was not found.');
    await client.query('UPDATE parts SET reorder_point=$2,target_quantity=$3,storage_location=$4,notes=$5,active=$6,metadata_revision=metadata_revision+1 WHERE id=$1',[part.partId,part.reorderPoint,part.targetQuantity,part.location,part.notes,part.active]);
    await audit(client,actor,'import_legacy_part',part.partId,old.rows[0],part,reason);
   }
   await client.query('UPDATE operational_settings SET settings=$1::jsonb,revision=revision+1,actor=$2::jsonb,updated_at=now() WHERE singleton=true',[json(next),json(actor)]);
   await audit(client,actor,operation,'settings',current.settings,next,reason);
   return {imported:true,parts:parts.length};
  }
  if(operation==='save_settings') {
   human(actor);const reason=text(input.reason,'Reason');const current=await settings(client,true);
   // Settings administration is restricted by the existing approver allowlist.
   approver(actor,current.settings);
   if(String(input.revision)!==current.revision)throw new InputError('Settings changed. Reload before saving.');
   const next=validatePolicy(input.settings);
   await client.query('UPDATE operational_settings SET settings=$1::jsonb,revision=revision+1,actor=$2::jsonb,updated_at=now() WHERE singleton=true',[json(next),json(actor)]);
   await audit(client,actor,operation,'settings',current.settings,next,reason);return {saved:true,revision:String(BigInt(current.revision)+1n)};
  }
  if(operation==='edit_part') {
   human(actor);const id=uuid(input.partId,'Part ID'),reason=text(input.reason,'Reason');
   const r=await client.query('SELECT * FROM parts WHERE id=$1 FOR UPDATE',[id]);const old=r.rows[0];if(!old)throw new InputError('Part was not found.');
   if(String(input.revision)!==String(old.metadata_revision))throw new InputError('Part changed. Reload before saving.');
   const reorder=quantity(input.reorderPoint,'Reorder point'),target=quantity(input.targetQuantity,'Target quantity');
   if(typeof input.active!=='boolean')throw new InputError('Active must be boolean.');
   const location=input.location===''?'':text(input.location,'Location');const notes=input.notes===''?'':text(input.notes,'Notes',4000);
   await client.query('UPDATE parts SET reorder_point=$2,target_quantity=$3,storage_location=$4,notes=$5,active=$6,metadata_revision=metadata_revision+1 WHERE id=$1',[id,reorder,target,location,notes,input.active]);
   await audit(client,actor,operation,id,old,{reorderPoint:reorder,targetQuantity:target,location,notes,active:input.active},reason);return {saved:true};
  }
  if(operation==='preview_count') {
   if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>200)throw new InputError('A batch requires 1–200 count lines.');
   const requested=input.lines.map(v=>{const l=object(v);return {partId:uuid(l.partId,'Part ID'),counted:quantity(l.counted,'Counted')};});
   if(new Set(requested.map(l=>l.partId)).size!==requested.length)throw new InputError('A part may appear only once in a batch.');
   await lockParts(client,requested.map(l=>l.partId));const policy=await settings(client);const lines=[];
   for(const l of requested)lines.push({...await snapshot(client,l.partId),counted:l.counted});
   return {lines:lines.map(l=>({...l,discrepancy:Number((l.counted-l.expected).toFixed(4))})),policySnapshot:policy.settings,settingsRevision:policy.revision,requiresApproval:needsApproval(policy.settings,lines)};
  }
  if(operation==='submit_count')return submitCount(db,client,actor,input);
  if(operation==='adjust') {
   const delta=parseQuantity(input.quantityDelta,{label:'The adjustment',nonZero:true}); const reason=text(input.reason,'Reason'); const part=parsePartRef(input.partId);
   const policy=await settings(client,true);void policy;
   const idrows=part.kind==='id'?await client.query('SELECT id FROM parts WHERE id=$1',[part.id]):await client.query('SELECT id FROM parts WHERE vendor=$1 AND lower(vendor_part_number)=lower($2)',[part.vendor,part.vendorPartNumber]);
   let id=idrows.rows[0]?.id;
   if(!id&&part.kind==='vendor') {await client.query('INSERT INTO parts(vendor,vendor_part_number) VALUES($1,$2) ON CONFLICT DO NOTHING',[part.vendor,part.vendorPartNumber]);id=(await client.query('SELECT id FROM parts WHERE vendor=$1 AND lower(vendor_part_number)=lower($2)',[part.vendor,part.vendorPartNumber])).rows[0]?.id;}
   if(!id)throw new InputError('Part was not found.');
   const key=input.reference?`adjust:${id}:${text(input.reference,'Reference')}`:`adjust:${randomUUID()}`;
   const previous=await client.query('SELECT * FROM physical_counts WHERE submission_key=$1',[key]);
   if(previous.rows[0]) {const payload=previous.rows[0].payload;if(Number((payload.lines[0].counted-payload.lines[0].expected).toFixed(4))!==delta||payload.reason!==reason)throw new InputError('Reference was already used with a different adjustment.');return {countId:previous.rows[0].id,status:previous.rows[0].status,duplicate:true};}
   await lockParts(client,[id]);const snap=await snapshot(client,id);
   return submitCount(db,client,actor,{submissionKey:key,reason,lines:[{...snap,counted:Number((snap.expected+delta).toFixed(4))}]},true);
  }
  if(operation==='refresh_refund_count') {
   const current=await settings(client,true);const id=uuid(input.countId,'Count ID');const reason=text(input.reason,'Refresh reason');
   const result=await client.query('SELECT * FROM physical_counts WHERE id=$1 FOR UPDATE',[id]);const count=result.rows[0];
   if(!count||!count.submission_key.startsWith('["bc-refund",'))throw new InputError('A BigCommerce refund count is required.');
   approver(actor,current.settings);approver(actor,count.policy_snapshot);
   if(count.status!=='rejected')throw new InputError('Reject the stale refund before refreshing it.');
   const prior=await client.query("SELECT after_value FROM operational_audit WHERE operation='refresh_refund_count' AND target=$1",[id]);
   if(prior.rows[0])return {...prior.rows[0].after_value,duplicate:true};
   // A later proposal may have become stale because an earlier refund was
   // approved. Rebuild only its remaining credit from the pinned line BOM.
   const key=JSON.parse(count.submission_key.slice(0,count.submission_key.lastIndexOf(']')+1));
   const remaining=Number(key[3])-await appliedRefundUnits(client,key[1],key[2]);
   if(remaining<=0)throw new InputError('This refund has already been credited.');
   const line=await client.query('SELECT expansion FROM bigcommerce_lines WHERE order_id=$1 AND line_id=$2',[key[1],key[2]]);
   if(!line.rows[0])throw new InputError('The refund order line was not found.');
   const parts=await client.query('SELECT id,vendor,vendor_part_number FROM parts');
   const ids=new Map(parts.rows.map(p=>[`${p.vendor}:${p.vendor_part_number}`.toLowerCase(),p.id]));
   const deltas=line.rows[0].expansion.map((p:{part:string;quantity:number})=>{
    const partId=ids.get(p.part.toLowerCase());if(!partId)throw new InputError('Pinned BOM part no longer exists.');
    return {partId,quantity:Number((remaining*p.quantity).toFixed(4))};
   });
   const submissionKey=`${count.submission_key}:after:${id}`;
   const next=await submitAdjustmentBatch(db,client,actor,deltas,submissionKey,count.reason,true);
   await audit(client,actor,operation,id,{countId:id,status:count.status},{...next,submissionKey},reason);
   return next;
  }
  if(operation==='approve_count'||operation==='reject_count') {
   const current=await settings(client,true);const id=uuid(input.countId,'Count ID');const reason=text(input.reason,'Decision reason');
   const result=await client.query('SELECT * FROM physical_counts WHERE id=$1 FOR UPDATE',[id]);const count=result.rows[0];if(!count)throw new InputError('Count was not found.');
   approver(actor,current.settings,operation==='approve_count'?count.submitted_by:undefined);
   approver(actor,count.policy_snapshot,operation==='approve_count'?count.submitted_by:undefined);
   if(count.status!=='pending') {if(count.status===(operation==='approve_count'?'applied':'rejected'))return {countId:id,status:count.status,duplicate:true};throw new InputError('Count already has a final decision.');}
   if(operation==='reject_count') {await client.query("UPDATE physical_counts SET status='rejected',decided_by=$2::jsonb,decided_at=now(),decision_reason=$3 WHERE id=$1",[id,json(actor),reason]);return {countId:id,status:'rejected',duplicate:false};}
   if(String(count.settings_revision)!==current.revision)throw new InputError('Approval policy changed. Reject this submission and preview a new count.');
   return applyCount(db,client,count,actor,reason);
  }
  if(operation==='preview_receipt') {
   const orderId=uuid(input.orderId,'Order ID');const shipment=text(input.shipmentReference,'Shipment reference');
   if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>200)throw new InputError('Receiving requires 1–200 lines.');
   const requested=input.lines.map(v=>{const l=object(v);return {partId:uuid(l.partId,'Part ID'),quantity:parseQuantity(l.quantity,{label:'Receipt quantity',positive:true})};});
   if(new Set(requested.map(l=>l.partId)).size!==requested.length)throw new InputError('A part may appear only once per shipment.');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`receipt:${orderId}:${shipment}`]);
   await lockParts(client,requested.map(l=>l.partId));const state=await orderRows(client,orderId);const lines=requested.map(l=>{const old=state.lines.find(x=>x.partId===l.partId);if(!old)throw new InputError('Receipt line does not belong to the order.');return {...old,quantity:l.quantity,overage:Math.max(0,l.quantity-old.outstanding)};});
   const reason=typeof input.reason==='string'?input.reason.trim():'';
   if(lines.some(l=>l.overage>0)&&!reason)throw new InputError('Overages require a reason.');if(reason)text(reason,'Reason');
   const old=await client.query('SELECT * FROM receipt_previews WHERE order_id=$1 AND shipment_reference=$2 FOR UPDATE',[orderId,shipment]);
   if(old.rows[0]?.applied_at) {if(json(old.rows[0].lines.map((l:any)=>[l.partId,l.quantity]).sort())!==json(lines.map(l=>[l.partId,l.quantity]).sort()))throw new InputError('Shipment reference was already used for different quantities.');return {previewId:old.rows[0].id,lines:old.rows[0].lines,duplicate:true,applied:true};}
   const r=await client.query(`INSERT INTO receipt_previews(order_id,shipment_reference,reason,actor,lines) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
     ON CONFLICT(order_id,shipment_reference) DO UPDATE SET id=gen_random_uuid(),reason=excluded.reason,actor=excluded.actor,lines=excluded.lines,created_at=now() RETURNING id`,[orderId,shipment,reason,json(actor),json(lines)]);
   return {previewId:r.rows[0].id,lines,shipmentReference:shipment,reason,duplicate:false};
  }
  if(operation==='confirm_receipt') {
   const id=uuid(input.previewId,'Receipt preview ID');
   const initial=await client.query('SELECT * FROM receipt_previews WHERE id=$1',[id]);const observed=initial.rows[0];if(!observed)throw new InputError('Receipt preview was not found.');
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`receipt:${observed.order_id}:${observed.shipment_reference}`]);
   await lockParts(client,observed.lines.map((l:any)=>l.partId));
   const r=await client.query('SELECT * FROM receipt_previews WHERE id=$1 FOR UPDATE',[id]);const preview=r.rows[0];if(!preview)throw new InputError('Receipt preview was not found.');
   if(preview.applied_at)return {previewId:id,duplicate:true};
   const lines=preview.lines;
   const current=await orderRows(client,preview.order_id);
   for(const l of lines){const state=current.lines.find(x=>x.partId===l.partId);if(!state||state.ledgerRevision!==l.ledgerRevision||state.outstanding!==l.outstanding)throw new InputError('Stale receiving preview. Preview this shipment again.');}
   for(const l of lines) {const entry=await appendEntry(db,{part:{kind:'id',id:l.partId},entryType:'receipt',quantity:l.quantity,reference:current.order.vendor_order_number,idempotencyScope:['native-receipt',id],unitCost:Number(l.unitCost),note:preview.reason||'Shipment received',createdBy:actor.id,provenance:{source:'native_receipt',companyId:actor.companyId,previewId:id,shipmentReference:preview.shipment_reference,orderId:preview.order_id,submittedBy:preview.actor,confirmedBy:actor,reason:preview.reason}},client);await client.query('INSERT INTO receipt_history(preview_id,part_id,ledger_entry_id,quantity) VALUES($1,$2,$3,$4)',[id,l.partId,entry.entry.id,l.quantity]);}
   await client.query('UPDATE receipt_previews SET applied_at=now(),applied_by=$2::jsonb WHERE id=$1',[id,json(actor)]);return {previewId:id,duplicate:false,received:true};
  }
  if(operation==='short_close') {
   human(actor);const orderId=uuid(input.orderId,'Order ID'),partId=uuid(input.partId,'Part ID'),reason=text(input.reason,'Reason'),key=text(input.submissionKey,'Submission key');
   await lockParts(client,[partId]);const previous=await client.query('SELECT * FROM order_short_closes WHERE submission_key=$1',[key]);
   if(previous.rows[0]){if(previous.rows[0].order_id!==orderId||previous.rows[0].part_id!==partId||previous.rows[0].reason!==reason)throw new InputError('Submission key was already used for a different short-close.');return {shortCloseId:previous.rows[0].id,duplicate:true};}
   const current=await orderRows(client,orderId);const line=current.lines.find(l=>l.partId===partId);if(!line)throw new InputError('Order line was not found.');
   if(line.ledgerRevision!==String(input.ledgerRevision)||line.outstanding!==quantity(input.outstanding,'Outstanding'))throw new InputError('Stale order snapshot. Reload before short-close.');
   if(line.outstanding<=0)throw new InputError('No outstanding quantity to close.');
   const r=await client.query('INSERT INTO order_short_closes(submission_key,order_id,part_id,quantity,reason,actor) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id',[key,orderId,partId,line.outstanding,reason,json(actor)]);
   await audit(client,actor,operation,orderId,line,{closed:line.outstanding},reason);return {shortCloseId:r.rows[0].id,closed:line.outstanding};
  }
  throw new InputError('Unknown inventory operation.');
 });
}

export async function readNative(db:DatabaseHandle,page:string,input:Record<string,unknown>):Promise<Record<string,unknown>> {
 return db.transaction(async client=>{
  if(page==='settings') {const current=await settings(client);const history=await client.query("SELECT * FROM operational_audit WHERE target='settings' ORDER BY id DESC LIMIT 100");return {...current,history:history.rows};}
  if(page==='inventory') {
   const search=typeof input.search==='string'?input.search.slice(0,200):'';const vendor=typeof input.vendor==='string'?input.vendor:null;
   if(input.active!==undefined&&!['all','true','false'].includes(String(input.active)))throw new InputError('Unknown active filter.');
   const rows=await client.query(`SELECT s.*,s.part_id AS "partId",p.reorder_point AS "reorderPoint",p.target_quantity AS "targetQuantity",p.storage_location AS location,p.notes,p.active,p.metadata_revision::text AS revision,
    costs.last_cost AS "lastCost",costs.average_cost AS "averageCost",costs.last_ordered AS "lastOrdered",
    COALESCE((SELECT max(e.id) FROM ledger_entries e WHERE e.part_id=p.id),0)::text AS "ledgerRevision"
    FROM part_stock s JOIN parts p ON p.id=s.part_id LEFT JOIN LATERAL (
    SELECT (array_agg(unit_cost ORDER BY created_at DESC,id DESC) FILTER(WHERE unit_cost IS NOT NULL))[1] AS last_cost,
    sum(unit_cost*quantity_delta) FILTER(WHERE entry_type='purchase')/NULLIF(sum(quantity_delta) FILTER(WHERE entry_type='purchase' AND unit_cost IS NOT NULL),0) AS average_cost,
    max(created_at) FILTER(WHERE entry_type='purchase') AS last_ordered FROM ledger_entries WHERE part_id=p.id) costs ON true
    WHERE (p.description ILIKE '%'||$1||'%' OR p.vendor_part_number ILIKE '%'||$1||'%' OR p.vendor ILIKE '%'||$1||'%' OR p.storage_location ILIKE '%'||$1||'%')
    AND ($2::text IS NULL OR p.vendor=$2) AND ($3::text IS NULL OR p.active=($3='true')) AND (NOT $4::boolean OR s.available<=p.reorder_point)
    ORDER BY p.vendor,p.vendor_part_number LIMIT 1000`,[search,vendor,input.active===undefined||input.active==='all'?null:String(input.active),input.lowStock===true]);
   return {parts:rows.rows};
  }
  if(page==='counts'||page==='review') {
   const counts=await client.query(`SELECT c.*,COALESCE((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('vendor',p.vendor,'vendorPartNumber',p.vendor_part_number) ORDER BY l.part_id) FROM physical_count_lines l JOIN parts p ON p.id=l.part_id WHERE l.count_id=c.id),'[]'::jsonb) AS lines FROM physical_counts c WHERE c.status='pending' OR c.id IN (SELECT id FROM physical_counts WHERE status<>'pending' ORDER BY submitted_at DESC,id LIMIT 200) ORDER BY (c.status='pending') DESC,c.submitted_at DESC,c.id`);
   if(page==='counts')return {counts:counts.rows};
   const review=await client.query(`SELECT r.*,(SELECT provenance FROM email_intake i WHERE i.review_id=r.id LIMIT 1) AS intake_provenance FROM review_queue r WHERE r.status='open' OR r.id IN (SELECT id FROM review_queue WHERE status<>'open' ORDER BY created_at DESC,id LIMIT 200) ORDER BY (r.status='open') DESC,r.created_at DESC,r.id`);
   return {counts:counts.rows,items:review.rows};
  }
  if(page==='receiving') {
   const orders=await client.query('SELECT id,vendor,vendor_order_number,order_date,status FROM orders ORDER BY created_at DESC LIMIT 200');
   const details=input.orderId?await orderRows(client,uuid(input.orderId,'Order ID')):undefined;
   const history=await client.query(`SELECT r.*,COALESCE((SELECT jsonb_agg(h) FROM receipt_history h WHERE h.preview_id=r.id),'[]'::jsonb) AS receipts FROM receipt_previews r WHERE r.applied_at IS NOT NULL ORDER BY r.applied_at DESC LIMIT 100`);
   const closed=await client.query('SELECT * FROM order_short_closes ORDER BY created_at DESC LIMIT 100');
   return {orders:orders.rows,...details,history:history.rows,shortCloses:closed.rows};
  }
  if(page==='history') {
   const id=uuid(input.partId,'Part ID');const entries=await client.query('SELECT * FROM ledger_entries WHERE part_id=$1 ORDER BY id DESC LIMIT 500',[id]);const audit=await client.query('SELECT * FROM operational_audit WHERE target=$1 ORDER BY id DESC LIMIT 100',[id]);return {entries:entries.rows,audit:audit.rows};
  }
  if(page==='dashboard') {
   const r=await client.query(`SELECT (SELECT count(*) FROM part_stock s JOIN parts p ON p.id=s.part_id WHERE p.active AND s.available<=p.reorder_point)::int AS "lowStock",(SELECT count(*) FROM physical_counts WHERE status='pending')::int AS "pendingCounts",(SELECT count(*) FROM review_queue WHERE status='open')::int AS "pendingReviews",(SELECT count(*) FROM part_stock WHERE on_hand<0)::int AS "negativeStock"`);return r.rows[0];
  }
  throw new InputError('Unknown inventory page.');
 });
}
