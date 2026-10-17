import {afterEach,beforeEach,expect,it} from 'vitest';
import {executeNative,readNative,type NativeActor} from '../src/native-service.js';
import {appendEntry} from '../src/ledger.js';
import {freshSchema,dropSchema,insertPart,exec,integration,type TestSchema} from './support/database.js';
const submitter:NativeActor={type:'agent',id:'synthetic-agent',companyId:'synthetic-company'};
const reviewer:NativeActor={type:'user',id:'synthetic-human',companyId:'synthetic-company'};
integration('native reconciliation',()=>{
 let t:TestSchema;let partId:string;
 beforeEach(async()=>{t=await freshSchema();partId=await insertPart(t,'mcmaster','SYNTHETIC-PART');await appendEntry(t.db,{part:{kind:'id',id:partId},entryType:'receipt',quantity:10,reference:'seed',createdBy:'synthetic',provenance:{source:'synthetic-test'}});});
 afterEach(async()=>dropSchema(t));
 const preview=async(counted=12)=>executeNative(t.db,submitter,'preview_count',{lines:[{partId,counted}]});
 const submit=async(key:string,counted=12)=>{const p=await preview(counted);return executeNative(t.db,submitter,'submit_count',{submissionKey:key,reason:'Synthetic shelf count',lines:p.lines});};
 it('previews without writes, requires human approval and links exactly one adjustment',async()=>{
  const p=await preview();expect(p.requiresApproval).toBe(true);expect(await exec(t,'SELECT * FROM physical_counts')).toHaveLength(0);
  const c=await submit('one');expect(c.status).toBe('pending');
  await expect(executeNative(t.db,submitter,'approve_count',{countId:c.countId,reason:'Reviewed'})).rejects.toThrow(/human/i);
  const approved=await executeNative(t.db,reviewer,'approve_count',{countId:c.countId,reason:'Verified shelf'});expect(approved.status).toBe('applied');
  expect((await executeNative(t.db,reviewer,'approve_count',{countId:c.countId,reason:'Retry'})).duplicate).toBe(true);
  const links=await exec(t,"SELECT e.id,l.ledger_entry_id,e.count_line_id,l.id AS line_id FROM ledger_entries e JOIN physical_count_lines l ON l.id=e.count_line_id WHERE e.entry_type='adjustment'");
  expect(links).toHaveLength(1);expect(String(links[0].id)).toBe(String(links[0].ledger_entry_id));expect(links[0].count_line_id).toBe(links[0].line_id);
 });
 it('deduplicates concurrent submissions and refuses changed quantities',async()=>{
  const p=await preview();const input={submissionKey:'concurrent',reason:'Shelf',lines:p.lines};
  const results=await Promise.all([executeNative(t.db,submitter,'submit_count',input),executeNative(t.db,submitter,'submit_count',input)]);
  expect(results[0].countId).toBe(results[1].countId);expect(results.filter(r=>r.duplicate)).toHaveLength(1);
  await expect(executeNative(t.db,submitter,'submit_count',{...input,lines:[{...(p.lines as any[])[0],counted:13}]})).rejects.toThrow(/different counts/);
 });
 it('rejects stale batches atomically and retains immutable original counts',async()=>{
  const second=await insertPart(t,'mcmaster','SYNTHETIC-SECOND');
  const p=await executeNative(t.db,submitter,'preview_count',{lines:[{partId,counted:12},{partId:second,counted:2}]});
  const c=await executeNative(t.db,submitter,'submit_count',{submissionKey:'batch',reason:'Batch count',lines:p.lines});
  await appendEntry(t.db,{part:{kind:'id',id:second},entryType:'receipt',quantity:1,reference:'later',createdBy:'synthetic',provenance:{source:'synthetic-test'}});
  await expect(executeNative(t.db,reviewer,'approve_count',{countId:c.countId,reason:'Reviewed'})).rejects.toThrow(/Stale/);
  expect(await exec(t,"SELECT * FROM ledger_entries WHERE entry_type='adjustment'")).toHaveLength(0);
  expect((await exec(t,'SELECT status FROM physical_counts WHERE id=$1',[c.countId]))[0].status).toBe('pending');
  await expect(exec(t,'UPDATE physical_count_lines SET counted=99 WHERE count_id=$1',[c.countId])).rejects.toThrow(/immutable/);
 });
 it('rejects a submission without changing stock and refuses direct ledger bypass',async()=>{
  const c=await submit('reject');await executeNative(t.db,reviewer,'reject_count',{countId:c.countId,reason:'Count again'});
  expect(await exec(t,"SELECT * FROM ledger_entries WHERE entry_type='adjustment'")).toHaveLength(0);
  await expect(appendEntry(t.db,{part:{kind:'id',id:partId},entryType:'adjustment',quantity:1,reference:'bypass',createdBy:'synthetic',provenance:{source:'synthetic-test'}})).rejects.toThrow(/reconciliation policy/);
 });
 it('applies the same thresholds to legacy adjustments and count submissions',async()=>{
  const settings=await readNative(t.db,'settings',{});
  await executeNative(t.db,reviewer,'save_settings',{revision:settings.revision,reason:'Synthetic policy',settings:{...(settings.settings as any),approvalMode:'threshold',absoluteThreshold:2,percentThreshold:30}});
  const within=await executeNative(t.db,submitter,'adjust',{partId,quantityDelta:1,reference:'within',reason:'Shelf correction'});expect(within.status).toBe('applied');
  const over=await executeNative(t.db,submitter,'adjust',{partId,quantityDelta:5,reference:'over',reason:'Shelf correction'});expect(over.status).toBe('pending');
  const retry=await executeNative(t.db,submitter,'adjust',{partId,quantityDelta:1,reference:'within',reason:'Shelf correction'});expect(retry.duplicate).toBe(true);
 });
 it('keeps old pending counts and open reviews visible after more than 200 decisions',async()=>{
  const pending=await submit('old-pending');
  await exec(t,`INSERT INTO physical_counts(submission_key,reason,submitted_by,policy_snapshot,settings_revision,payload,status,submitted_at,decided_by,decided_at,decision_reason)
   SELECT 'newer-'||n,'Synthetic history','{}',s.settings,s.revision,'{}','rejected',now()+interval '1 day','{}',now(),'Synthetic rejected' FROM generate_series(1,205) n CROSS JOIN operational_settings s`);
  const open=await exec(t,"INSERT INTO review_queue(reason,created_at) VALUES('Old pending',now()-interval '1 day') RETURNING id");
  await exec(t,"INSERT INTO review_queue(reason,status,resolved_at,created_at) SELECT 'Newer history','rejected',now(),now() FROM generate_series(1,205)");
  const counts=await readNative(t.db,'counts',{}),review=await readNative(t.db,'review',{});
  expect((counts.counts as any[]).map(c=>c.id)).toContain(pending.countId);
  expect((review.counts as any[]).map(c=>c.id)).toContain(pending.countId);
  expect((review.items as any[]).map(c=>c.id)).toContain(open[0].id);
  expect(counts.counts).toHaveLength(201);expect(review.items).toHaveLength(201);
 });
 it('imports offline metadata once, validates every line and leaves stock untouched',async()=>{
  const current=await readNative(t.db,'settings',{});
  const part={partId,reorderPoint:2,targetQuantity:8,location:'Synthetic shelf',notes:'Offline import',active:true};
  const input={revision:current.revision,reason:'Offline export reviewed',settings:current.settings,parts:[part]};
  await expect(executeNative(t.db,submitter,'import_legacy_settings',input)).rejects.toThrow(/human/);
  await expect(executeNative(t.db,reviewer,'import_legacy_settings',{...input,parts:[part,{...part,partId:'00000000-0000-0000-0000-000000000001',reorderPoint:-1}]})).rejects.toThrow(/negative/);
  expect(Number((await exec(t,'SELECT reorder_point FROM parts WHERE id=$1',[partId]))[0].reorder_point)).toBe(0);
  expect(await executeNative(t.db,reviewer,'import_legacy_settings',input)).toMatchObject({imported:true,parts:1});
  const after=await readNative(t.db,'settings',{});
  await expect(executeNative(t.db,reviewer,'import_legacy_settings',{...input,revision:after.revision})).rejects.toThrow(/already been imported/);
  expect(Number((await exec(t,'SELECT on_hand FROM part_stock WHERE part_id=$1',[partId]))[0].on_hand)).toBe(10);
 });
 it('enforces self approval and policy changes at decision time',async()=>{
  const p=await preview();const c=await executeNative(t.db,reviewer,'submit_count',{submissionKey:'self',reason:'Shelf',lines:p.lines});
  await expect(executeNative(t.db,reviewer,'approve_count',{countId:c.countId,reason:'Self'})).rejects.toThrow(/own count/);
  const s=await readNative(t.db,'settings',{});await executeNative(t.db,reviewer,'save_settings',{revision:s.revision,reason:'Policy update',settings:s.settings});
  await expect(executeNative(t.db,{...reviewer,id:'other-human'},'approve_count',{countId:c.countId,reason:'Reviewed'})).rejects.toThrow(/policy changed/);
 });
});

integration('native receiving',()=>{
 let t:TestSchema;let partId:string;let orderId:string;
 beforeEach(async()=>{
  t=await freshSchema();partId=await insertPart(t,'mcmaster','SYNTHETIC-RECEIVE');
  const orders=await exec(t,"INSERT INTO orders(vendor,vendor_order_number,order_date,subtotal) VALUES('mcmaster','SYNTHETIC-PO','2026-01-01',40) RETURNING id");orderId=String(orders[0].id);
  await exec(t,'INSERT INTO order_lines(order_id,part_id,quantity,unit_price,line_total,line_number) VALUES($1,$2,20,2,40,1)',[orderId,partId]);
  await appendEntry(t.db,{part:{kind:'id',id:partId},entryType:'purchase',quantity:20,reference:'SYNTHETIC-PO',createdBy:'synthetic',provenance:{source:'synthetic-test'}});
 });
 afterEach(async()=>dropSchema(t));
 const preview=(q:number,shipmentReference='synthetic-shipment',reason='')=>executeNative(t.db,submitter,'preview_receipt',{orderId,shipmentReference,reason,lines:[{partId,quantity:q}]});
 it('records 21 received against 20 ordered, requires an overage reason and confirms once under concurrency',async()=>{
  await expect(preview(21)).rejects.toThrow(/reason/);const p=await preview(21,'overage','One extra verified');
  const results=await Promise.all([executeNative(t.db,reviewer,'confirm_receipt',{previewId:p.previewId}),executeNative(t.db,reviewer,'confirm_receipt',{previewId:p.previewId})]);
  expect(results.filter(r=>r.duplicate)).toHaveLength(1);
  const stock=await exec(t,'SELECT on_hand,on_order FROM part_stock WHERE part_id=$1',[partId]);expect(Number(stock[0].on_hand)).toBe(21);expect(Number(stock[0].on_order)).toBe(0);
  const history=await readNative(t.db,'receiving',{orderId});expect(history.history).toHaveLength(1);
 });
 it('invalidates a prior confirmation token when a shipment preview is changed',async()=>{
  const first=await preview(5,'changed');const revised=await preview(6,'changed');
  expect(first.previewId).not.toBe(revised.previewId);
  await expect(executeNative(t.db,reviewer,'confirm_receipt',{previewId:first.previewId})).rejects.toThrow(/not found/);
  expect(await exec(t,"SELECT * FROM ledger_entries WHERE entry_type='receipt'")).toHaveLength(0);
 });
 it('serializes concurrent preview replacement and confirmation without deadlocks',async()=>{
  const first=await preview(5,'race');
  // Pause confirmation after its first preview read, then let refresh reach its
  // preview-row query. The former row-first locking deadlocked at this barrier.
  let observed!:()=>void,release!:()=>void,refreshReached!:()=>void;
  const read=new Promise<void>(r=>observed=r),gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>refreshReached=r);
  const wrap=(mode:string)=>({...t.db,transaction:(fn:any)=>t.db.transaction(c=>fn(new Proxy(c,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return async(sql:string,args:any[])=>{
    if(mode==='preview'&&sql.startsWith('SELECT * FROM receipt_previews WHERE order_id'))refreshReached();
    const result=await target.query(sql,args);
    if(mode==='confirm'&&sql.startsWith('SELECT * FROM receipt_previews WHERE id=')){observed();await gate;}
    return result;
   };
  }})))});
  const confirm=executeNative(wrap('confirm') as any,reviewer,'confirm_receipt',{previewId:first.previewId});
  await read;
  const refreshed=executeNative(wrap('preview') as any,submitter,'preview_receipt',{orderId,shipmentReference:'race',lines:[{partId,quantity:5}]});
  await waiting;release();
  const results=await Promise.allSettled([refreshed,confirm]);
  for(const result of results)if(result.status==='rejected')expect(result.reason.message).toMatch(/not found/);
  expect(results[0].status).toBe('fulfilled');
  if(results[0].status==='fulfilled')await executeNative(t.db,reviewer,'confirm_receipt',{previewId:results[0].value.previewId});
  expect(Number((await exec(t,'SELECT on_hand FROM part_stock WHERE part_id=$1',[partId]))[0].on_hand)).toBe(5);
  expect(await exec(t,'SELECT * FROM receipt_history')).toHaveLength(1);
 });
 it('receives partial shipments, rejects stale previews, and audits short close separately',async()=>{
  const first=await preview(5,'first');const stale=await preview(4,'stale');
  await executeNative(t.db,reviewer,'confirm_receipt',{previewId:first.previewId});
  await expect(executeNative(t.db,reviewer,'confirm_receipt',{previewId:stale.previewId})).rejects.toThrow(/Stale/);
  const receiving=await readNative(t.db,'receiving',{orderId});const line=(receiving.lines as any[])[0];expect(line.outstanding).toBe(15);
  await executeNative(t.db,reviewer,'short_close',{orderId,partId,outstanding:line.outstanding,ledgerRevision:line.ledgerRevision,submissionKey:'short-close',reason:'Vendor cancelled remainder'});
  const stock=await exec(t,'SELECT on_hand,on_order FROM part_stock WHERE part_id=$1',[partId]);expect(Number(stock[0].on_hand)).toBe(5);expect(Number(stock[0].on_order)).toBe(0);
  expect(await exec(t,'SELECT * FROM order_short_closes')).toHaveLength(1);
 });
});
