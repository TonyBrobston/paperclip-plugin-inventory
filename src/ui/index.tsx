import React, { useState } from 'react';
import { usePluginData, usePluginAction, useHostNavigation, useHostLocation } from '@paperclipai/plugin-sdk/ui';

type Row = Record<string, any>;
const pages = ['inventory','counts','receiving','review','settings'] as const;
const label = (s:string) => ({inventory:'Inventory',counts:'Physical Counts',receiving:'Receiving',review:'Needs Review',settings:'Settings'}[s] ?? s);
function Table({rows,columns}:{rows:Row[];columns:[string,string][]}) {
 return <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',textAlign:'left'}}><thead><tr>{columns.map(([key,title])=><th key={key} style={{padding:8,borderBottom:'1px solid #888'}}>{title}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.id??r.partId??i}>{columns.map(([key])=><td key={key} style={{padding:8,borderBottom:'1px solid #8884'}}>{String(r[key]??'—')}</td>)}</tr>)}</tbody></table>{!rows.length&&<p>No records.</p>}</div>;
}
function Field({name,children}:{name:string;children:React.ReactNode}) {return <label style={{display:'inline-flex',flexDirection:'column',gap:4,margin:'6px 12px 6px 0'}}>{name}{children}</label>;}
function History({partId}:{partId:string}) {
 const {data,loading,error}=usePluginData<Row>('inventory_page',{page:'history',partId});
 return <section><h3>Part history</h3>{loading&&<p>Loading…</p>}{error&&<p role="alert">{error.message}</p>}<Table rows={data?.entries??[]} columns={[["created_at","Time"],["entry_type","Type"],["quantity_delta","Quantity"],["reference","Reference"],["created_by","Recorded by"],["note","Reason"]]}/></section>;
}
export function InventoryPage() {
 const location=useHostLocation();
 const initial=new URLSearchParams(location.search);
 const [page,setPage]=useState<string>(()=>pages.includes(initial.get('page') as any)?initial.get('page')!:'inventory');
 const [search,setSearch]=useState(''),[vendor,setVendor]=useState(''),[active,setActive]=useState('true'),[lowStock,setLowStock]=useState(initial.get("lowStock")==="true");
 const [orderId,setOrderId]=useState('');
 const query=usePluginData<Row>('inventory_page',{page,search,...(vendor?{vendor}:{}),active,lowStock,...(orderId?{orderId}:{})});
 const action=usePluginAction('inventory_action');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [reason,setReason]=useState(''),[draft,setDraft]=useState<Record<string,string>>({}),[preview,setPreview]=useState<Row|null>(null);
 const [submissionKey,setSubmissionKey]=useState(()=>crypto.randomUUID());
 const [selected,setSelected]=useState<Row|null>(null),[history,setHistory]=useState('');
 const [shipment,setShipment]=useState(''),[corrections,setCorrections]=useState('');
 async function run(operation:string,input:Row={},done?:(r:Row)=>void) {
  if(busy)return;setBusy(true);setError('');setNotice('');
  try {const r=await action({operation,...input}) as Row;done?.(r);query.refresh();setNotice(r.status?`Count ${r.status}.`:r.duplicate?'Already recorded.':'Saved.');}
  catch(e){setError((e as Error).message??'Request failed.');}finally{setBusy(false);}
 }
 function reset(next:string){setPage(next);setPreview(null);setSelected(null);setHistory('');setDraft({});setReason('');setError('');setNotice('');setSubmissionKey(crypto.randomUUID());}
 const data=query.data;
 const parts:Row[]=data?.parts??[];
 const change=(id:string,value:string)=>{setDraft(d=>({...d,[id]:value}));setPreview(null);};
 const lines=()=>Object.entries(draft).filter(([,v])=>v!=='').map(([partId,value])=>({partId,[page==='receiving'?'quantity':'counted']:Number(value)}));
 return <main style={{padding:24,fontFamily:'system-ui',maxWidth:1400}}><h1>Inventory</h1><nav aria-label="Inventory pages" style={{display:'flex',gap:8,flexWrap:'wrap'}}>{pages.map(p=><button key={p} disabled={busy} aria-pressed={page===p} onClick={()=>reset(p)}>{label(p)}</button>)}</nav>
 <h2>{label(page)}</h2>{query.loading&&<p role="status">Loading…</p>}{(error||query.error)&&<p role="alert">{error||query.error?.message}</p>}{notice&&<p role="status">{notice}</p>}
 {page==='inventory'&&<>
  <Field name="Search parts"><input value={search} onChange={e=>setSearch(e.target.value)}/></Field><Field name="Vendor"><input value={vendor} onChange={e=>setVendor(e.target.value)}/></Field>
  <Field name="Status"><select value={active} onChange={e=>setActive(e.target.value)}><option value="all">All</option><option value="true">Active</option><option value="false">Inactive</option></select></Field>
  <Field name="Low stock only"><input type="checkbox" checked={lowStock} onChange={e=>setLowStock(e.target.checked)}/></Field>
  <Table rows={parts} columns={[["vendor","Vendor"],["vendor_part_number","Part"],["description","Description"],["on_hand","On hand"],["committed","Committed"],["on_order","On order"],["available","Available"],["lastCost","Last cost"],["averageCost","Average cost"],["lastOrdered","Last ordered"],["location","Location"]]}/>
  <Field name="Edit part or view history"><select value={selected?.partId??''} onChange={e=>{const p=parts.find(p=>p.partId===e.target.value)??null;setSelected(p);setHistory(p?.partId??'');}}><option value="">Choose part</option>{parts.map(p=><option key={p.partId} value={p.partId}>{p.vendor}:{p.vendor_part_number}</option>)}</select></Field>
  {selected&&<form key={selected.partId+selected.revision} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void run('edit_part',{partId:selected.partId,revision:selected.revision,reorderPoint:Number(f.get('reorder')),targetQuantity:Number(f.get('target')),location:f.get('location'),notes:f.get('notes'),active:f.get('active')==='on',reason:f.get('reason')},()=>setSelected(null));}}>
   <Field name="Reorder point"><input name="reorder" type="number" min="0" step="0.0001" defaultValue={selected.reorderPoint} required/></Field><Field name="Target quantity"><input name="target" type="number" min="0" step="0.0001" defaultValue={selected.targetQuantity} required/></Field>
   <Field name="Location"><input name="location" defaultValue={selected.location}/></Field><Field name="Notes"><textarea name="notes" defaultValue={selected.notes}/></Field><Field name="Active"><input name="active" type="checkbox" defaultChecked={selected.active}/></Field><Field name="Change reason"><input name="reason" required/></Field><button disabled={busy}>Save part</button>
  </form>}{history&&<History partId={history}/>}
 </>}
 {page==='counts'&&<>
  <CountEntry draft={draft} change={change}/>
  <Field name="Count reason"><input value={reason} onChange={e=>{setReason(e.target.value);setPreview(null);}} required/></Field>
  <button disabled={busy||!reason||!lines().length} onClick={()=>void run('preview_count',{lines:lines()},r=>setPreview(r))}>Preview batch</button>
  {preview&&<section><Table rows={preview.lines} columns={[["partId","Part"],["expected","Expected"],["counted","Counted"],["discrepancy","Difference"],["ledgerRevision","Ledger revision"]]}/><p>{preview.requiresApproval?'Human approval required.':'Within configured automatic approval thresholds.'} All lines apply atomically.</p><button disabled={busy} onClick={()=>void run('submit_count',{lines:preview.lines,reason,submissionKey},()=>{setPreview(null);setDraft({});setSubmissionKey(crypto.randomUUID());})}>Submit count</button></section>}
  <CountDecisions counts={data?.counts??[]} busy={busy} decide={(operation,input)=>void run(operation,input)}/>
 </>}
 {page==='receiving'&&<>
  <Field name="Order"><select value={orderId} onChange={e=>{setOrderId(e.target.value);setDraft({});setPreview(null);}}><option value="">Choose order</option>{(data?.orders??[]).map((o:Row)=><option key={o.id} value={o.id}>{o.vendor} — {o.vendor_order_number}</option>)}</select></Field>
  {orderId&&<><Table rows={data?.lines??[]} columns={[["vendorPartNumber","Part"],["ordered","Ordered"],["received","Previously received"],["closed","Short closed"],["outstanding","Outstanding"]]}/>
   {(data?.lines??[]).map((l:Row)=><Field key={l.partId} name={`Receive ${l.vendorPartNumber}`}><input type="number" min="0.0001" step="0.0001" value={draft[l.partId]??''} onChange={e=>change(l.partId,e.target.value)}/></Field>)}
   <Field name="Shipment reference"><input value={shipment} onChange={e=>{setShipment(e.target.value);setPreview(null);}}/></Field><Field name="Receipt / overage reason"><input value={reason} onChange={e=>{setReason(e.target.value);setPreview(null);}}/></Field>
   <button disabled={busy||!shipment||!lines().length} onClick={()=>void run('preview_receipt',{orderId,shipmentReference:shipment,reason,lines:lines()},setPreview)}>Preview receipt</button>
   {preview&&<section><Table rows={preview.lines} columns={[["vendorPartNumber","Part"],["quantity","Receiving"],["outstanding","Outstanding"],["overage","Overage"]]}/><button disabled={busy} onClick={()=>void run('confirm_receipt',{previewId:preview.previewId},()=>{setPreview(null);setDraft({});})}>Confirm receipt</button></section>}
   <h3>Short close outstanding lines</h3><p>Record undelivered quantities separately from receipts. A reason is required.</p>
   {(data?.lines??[]).filter((l:Row)=>l.outstanding>0).map((l:Row)=><button key={l.partId} disabled={busy||!reason} onClick={()=>void run('short_close',{orderId,partId:l.partId,outstanding:l.outstanding,ledgerRevision:l.ledgerRevision,submissionKey:crypto.randomUUID(),reason})}>Short close {l.vendorPartNumber}: {l.outstanding}</button>)}
  </>}
  <h3>Receipt history</h3><Table rows={data?.history??[]} columns={[["shipment_reference","Shipment"],["applied_at","Confirmed"],["reason","Reason"]]}/><h3>Short close history</h3><Table rows={data?.shortCloses??[]} columns={[["created_at","Time"],["part_id","Part"],["quantity","Quantity"],["reason","Reason"]]}/>
 </>}
 {page==='review'&&<>
  <CountDecisions counts={data?.counts??[]} busy={busy} decide={(op,input)=>void run(op,input)}/>
  {(data?.items??[]).map((item:Row)=><section key={item.id} style={{borderTop:'1px solid #888',padding:12}}><h3>{item.vendor} — {item.status}</h3><p>{typeof item.reason==='string'?item.reason:JSON.stringify(item.reasons??item.reason)}</p><details><summary>Extraction and provenance</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({agent:item.agent_extraction,parser:item.parser_extraction,provenance:item.intake_provenance,resolvedBy:item.resolved_by,resolvedAt:item.resolved_at,note:item.resolution_note},null,2)}</pre></details>
   {item.status==='open'&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);let correction;try{correction=corrections?JSON.parse(corrections):undefined;}catch{setError('Corrections must be valid JSON.');return;}void run('resolve_review',{reviewItemId:item.id,resolution:f.get('resolution'),note:f.get('note'),...(correction?{corrections:correction}:{})});}}>
    <Field name="Resolution"><select name="resolution"><option value="accept">Approve verified extraction</option><option value="accept_with_corrections">Resolve with corrections</option><option value="reject">Reject</option></select></Field><Field name="Decision reason"><input name="note" required/></Field><Field name="Corrected extraction (JSON, if needed)"><textarea value={corrections} onChange={e=>setCorrections(e.target.value)}/></Field><button disabled={busy}>Save decision</button>
   </form>}
  </section>)}
 </>}
 {page==='settings'&&data&&<form key={data.revision} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void run('save_settings',{settings:{enabledVendors:f.getAll('vendor'),approvalMode:f.get('approvalMode'),absoluteThreshold:Number(f.get('absoluteThreshold')),percentThreshold:Number(f.get('percentThreshold')),approverUserIds:String(f.get('approvers')??'').split(/[\n,]/).map(v=>v.trim()).filter(Boolean),allowSelfApproval:f.get('self')==='on'},revision:data.revision,reason});}}>
  <fieldset><legend>Enabled vendors</legend>{['mcmaster','sendcutsend','amazon','formlabs'].map(v=><Field key={v} name={v}><input name="vendor" type="checkbox" value={v} defaultChecked={data.settings.enabledVendors?.includes(v)}/></Field>)}</fieldset>
  <Field name="Adjustment approval"><select name="approvalMode" defaultValue={data.settings.approvalMode}><option value="all">Review every discrepancy</option><option value="threshold">Apply within thresholds automatically</option></select></Field>
  <Field name="Absolute quantity threshold"><input type="number" name="absoluteThreshold" min="0" step="0.0001" defaultValue={data.settings.absoluteThreshold} required/></Field>
  <Field name="Percentage threshold"><input type="number" name="percentThreshold" min="0" step="0.0001" defaultValue={data.settings.percentThreshold} required/></Field>
  <p>Threshold mode requires approval when either threshold is exceeded. Discrepancies against zero expected stock require approval.</p>
  <Field name="Approver user IDs (one per line; leave empty for any authorized human)"><textarea name="approvers" rows={4} defaultValue={data.settings.approverUserIds?.join('\n')??''}/></Field>
  <Field name="Allow submitters to approve their own counts"><input name="self" type="checkbox" defaultChecked={data.settings.allowSelfApproval}/></Field>
  <Field name="Change reason"><input value={reason} onChange={e=>setReason(e.target.value)} required/></Field><button disabled={busy}>Save settings</button><h3>Settings history</h3><Table rows={data.history??[]} columns={[["created_at","Time"],["reason","Reason"],["operation","Operation"]]}/>
 </form>}
 </main>;
}
function CountEntry({draft,change}:{draft:Record<string,string>;change:(id:string,value:string)=>void}) {
 const {data,error}=usePluginData<Row>('inventory_page',{page:'inventory',active:'true'});
 return <section><p>Enter observed quantities, then preview the entire batch.</p>{error&&<p role="alert">{error.message}</p>}{(data?.parts??[]).map((p:Row)=><Field key={p.partId} name={`${p.vendor}:${p.vendor_part_number} — ${p.description}`}><input aria-label={`Count ${p.vendor}:${p.vendor_part_number}`} type="number" min="0" step="0.0001" value={draft[p.partId]??''} onChange={e=>change(p.partId,e.target.value)}/></Field>)}</section>;
}
function CountDecisions({counts,busy,decide}:{counts:Row[];busy:boolean;decide:(op:string,input:Row)=>void}) {
 return <section><h3>Count submissions</h3>{counts.map(c=><section key={c.id} style={{borderTop:'1px solid #888',padding:12}}><p>{c.status} · {c.submitted_at} · {c.submitted_by?.id} · {c.reason}</p><Table rows={c.lines} columns={[["vendorPartNumber","Part"],["expected","Expected"],["counted","Counted"],["ledger_revision","Revision"],["ledger_entry_id","Adjustment"]]}/>{c.status==='pending'?<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const submitter=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;decide(submitter.value,{countId:c.id,reason:f.get('reason')});}}><Field name="Decision reason"><input name="reason" required/></Field><button value="approve_count" disabled={busy}>Approve batch</button><button value="reject_count" disabled={busy}>Reject batch</button></form>:<p>{c.decided_by?.id} · {c.decided_at} · {c.decision_reason}</p>}</section>)}</section>;
}
export function InventorySidebar() {const nav=useHostNavigation();return <a {...nav.linkProps('/inventory')}>Inventory</a>;}
export function InventoryDashboard() {
 const {data,loading,error}=usePluginData<Row>('inventory_page',{page:'dashboard'});const nav=useHostNavigation();
 return <section><h3>Inventory</h3>{loading&&<p>Loading…</p>}{error&&<p role="alert">{error.message}</p>}{data&&<><p><a {...nav.linkProps('/inventory?lowStock=true')}>{data.lowStock} low-stock parts</a> · <a {...nav.linkProps('/inventory?page=counts')}>{data.pendingCounts} pending counts</a> · <a {...nav.linkProps('/inventory?page=review')}>{data.pendingReviews} reviews</a> · <a {...nav.linkProps('/inventory')}>{data.negativeStock} negative-stock alerts</a></p></>}</section>;
}
