import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import {
  useGetTreatmentPlan, useUpdateTreatmentPlan, useAddTreatmentPlanItem, useUpdateTreatmentPlanItem,
  getGetTreatmentPlanQueryKey, type TreatmentPlan, type TreatmentPlanItem, type TreatmentPlanItemStatus, type StaffSession,
} from '@workspace/api-client-react';
import { Download, Plus, Printer } from 'lucide-react';
import { BackLink, InlineError, PageHeading, State } from '@/components/clinic-ui';
import { useLocale } from '@/lib/locale';
import { careLabel, dateText, errorText, invalidateCare, tr } from '@/lib/care';

const escapeHTML=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function documentHTML(plan:TreatmentPlan,ar:boolean){
 const e=escapeHTML,word=(en:string,arabic:string)=>e(tr(ar,en,arabic));
 return `<!doctype html><html lang="${ar?'ar':'en'}" dir="${ar?'rtl':'ltr'}"><head><meta charset="utf-8"><title>${e(plan.title)} - DentOzone</title><style>@page{size:A4;margin:22mm}body{font-family:"Noto Sans Arabic","Tahoma","DejaVu Sans",sans-serif;color:#193f46;line-height:1.7}header{border-bottom:3px solid #236b70;padding-bottom:20px;margin-bottom:32px}.brand{color:#236b70;font-size:24px;font-weight:800}h1{font-size:28px;margin:18px 0 4px}small{color:#66837f}table{border-collapse:collapse;width:100%;margin-top:25px}th,td{text-align:start;border-bottom:1px solid #dce8e2;padding:12px 8px;vertical-align:top}th{background:#eaf3ee;color:#285d61}footer{margin-top:50px;padding-top:12px;border-top:1px solid #dce8e2;font-size:11px;color:#66837f}</style></head><body><header><div class="brand">DentOzone</div><small>${word('CLINICAL TREATMENT PLAN','خطة العلاج السريرية')}</small></header><h1>${e(plan.title)}</h1><p><strong>${word('Patient','المريض')}:</strong> ${e(plan.patientName)}<br><strong>${word('Date','التاريخ')}:</strong> ${e(dateText(plan.createdAt,ar))}<br><strong>${word('Prepared by','أعدها')}:</strong> ${e(plan.createdByName)}<br><strong>${word('Status','الحالة')}:</strong> ${e(careLabel(plan.status,ar))}</p>${plan.goal?`<h2>${word('Goal','الهدف')}</h2><p>${e(plan.goal)}</p>`:''}<h2>${word('Planned care','العلاج المخطط')}</h2><table><thead><tr><th>#</th><th>${word('Treatment','العلاج')}</th><th>${word('Tooth','السن')}</th><th>${word('Priority','الأولوية')}</th><th>${word('Status','الحالة')}</th></tr></thead><tbody>${plan.items.map((item,i)=>`<tr><td>${i+1}</td><td>${e(item.description)}${item.notes?`<br><small>${e(item.notes)}</small>`:''}</td><td>${e(item.toothCode||'—')}</td><td>${item.priority}</td><td>${e(careLabel(item.status,ar))}</td></tr>`).join('')}</tbody></table><footer>DentOzone · ${word('Clinical care record','سجل الرعاية الطبية')}</footer></body></html>`;
}
function download(plan:TreatmentPlan,ar:boolean){const blob=new Blob([documentHTML(plan,ar)],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`dentozone-plan-${plan.id}.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000)}
function print(plan:TreatmentPlan,ar:boolean){const frame=document.createElement('iframe');frame.style.cssText='position:fixed;width:0;height:0;border:0;opacity:0';document.body.appendChild(frame);frame.onload=()=>{frame.contentWindow?.focus();frame.contentWindow?.print();setTimeout(()=>frame.remove(),60000)};frame.srcdoc=documentHTML(plan,ar)}

export default function TreatmentPlanPage({session}:{session:StaffSession}){
 const id=Number(useParams<{id:string}>().id),{language}=useLocale(),ar=language==='ar',qc=useQueryClient();
 const q=useGetTreatmentPlan(id,{query:{enabled:id>0,queryKey:getGetTreatmentPlanQueryKey(id)}});
 const update=useUpdateTreatmentPlan(),add=useAddTreatmentPlanItem(),updateItem=useUpdateTreatmentPlanItem();
 const [title,setTitle]=useState(''),[goal,setGoal]=useState('');
 const [editing,setEditing]=useState<TreatmentPlanItem|'new'|null>(null);
 const [description,setDescription]=useState(''),[toothCode,setToothCode]=useState(''),[priority,setPriority]=useState(2),[itemNotes,setItemNotes]=useState('');
 const [itemStatus,setItemStatus]=useState<TreatmentPlanItemStatus>('pending');
 const [error,setError]=useState(''),[saved,setSaved]=useState('');
 useEffect(()=>{if(q.data){setTitle(q.data.title);setGoal(q.data.goal||'')}},[q.data?.id]);
 const terminal=q.data?.status==='completed'||q.data?.status==='cancelled';
 const writable=['owner','dentist'].includes(session.role)&&!terminal;
 const changePlan=async(data:{title?:string;goal?:string|null;status?:'draft'|'active'|'completed'|'cancelled'})=>{
  if(!writable)return;
  setError('');
  try{await update.mutateAsync({planId:id,data});invalidateCare(qc,q.data?.patientId,undefined,undefined,id);setSaved(tr(ar,'Plan saved.','تم حفظ الخطة.'))}
  catch(e){setError(errorText(e,ar))}
 };
 const openItem=(item:TreatmentPlanItem|'new')=>{
  if(!writable)return;
  setEditing(item);setDescription(item==='new'?'':item.description);setToothCode(item==='new'?'':item.toothCode||'');
  setPriority(item==='new'?2:item.priority);setItemNotes(item==='new'?'':item.notes||'');
  setItemStatus(item==='new'?'pending':item.status);setError('');
 };
 const saveItem=async(e:React.FormEvent)=>{
  e.preventDefault();if(!editing||!writable)return;setError('');
  try{
   const data={description:description.trim(),toothCode:toothCode.trim()||null,priority,notes:itemNotes.trim()||null};
   if(editing==='new')await add.mutateAsync({planId:id,data});
   else await updateItem.mutateAsync({planId:id,itemId:editing.id,data:{...data,status:itemStatus}});
   invalidateCare(qc,q.data?.patientId,undefined,undefined,id);
   setEditing(null);setSaved(tr(ar,'Item saved.','تم حفظ البند.'));
  }catch(e){setError(errorText(e,ar))}
 };
 return <main className="page">
  <div style={{marginBottom:22}}><BackLink href={q.data?`/patients/${q.data.patientId}/clinical`:'/patients'} label={tr(ar,'Clinical record','السجل الطبي')}/></div>
  {q.isLoading?<State kind="loading"/>:q.isError?<State kind="error" onRetry={()=>q.refetch()}/>:q.data&&<>
   <PageHeading eyebrow={`${tr(ar,'TREATMENT PLAN','خطة العلاج')} / ${q.data.id}`} title={q.data.title} subtitle={`${q.data.patientName} · ${dateText(q.data.createdAt,ar)}`} action={<span className="care-pill">{careLabel(q.data.status,ar)}</span>}/>
   <div className="care-toolbar"><div className="care-actions">
    <button className="btn btn-outline" onClick={()=>print(q.data!,ar)} data-testid="button-print-plan"><Printer size={16}/>{tr(ar,'Print / Save PDF','طباعة / حفظ PDF')}</button>
    <button className="btn btn-outline" onClick={()=>download(q.data!,ar)} data-testid="button-download-plan"><Download size={16}/>{tr(ar,'Download HTML','تنزيل HTML')}</button>
   </div><Link className="btn btn-outline" href={`/patients/${q.data.patientId}/clinical`} data-testid="link-plan-patient">{tr(ar,'Patient record','سجل المريض')}</Link></div>
   <div className="care-grid"><div className="care-stack">
    <section className="care-panel"><div className="care-kicker">{tr(ar,'DIRECTION OF CARE','مسار العلاج')}</div>
     {terminal?<div><div className="care-row"><span className="care-muted">{tr(ar,'Title','العنوان')}</span><strong>{q.data.title}</strong></div><div className="care-row"><span className="care-muted">{tr(ar,'Goal','الهدف')}</span><strong>{q.data.goal||'—'}</strong></div></div>:<>
      <div className="care-form"><label className="care-field care-span">{tr(ar,'Plan title','عنوان الخطة')}<input value={title} disabled={!writable} onChange={e=>setTitle(e.target.value)} data-testid="input-plan-edit-title"/></label>
       <label className="care-field care-span">{tr(ar,'Goal','الهدف')}<textarea rows={3} value={goal} disabled={!writable} onChange={e=>setGoal(e.target.value)} data-testid="input-plan-edit-goal"/></label></div>
      {writable&&<button className="btn btn-primary" style={{marginTop:15}} disabled={update.isPending||!title.trim()} onClick={()=>changePlan({title:title.trim(),goal:goal.trim()||null})} data-testid="button-save-plan">{tr(ar,'Save plan','حفظ الخطة')}</button>}
     </>}
    </section>
    <section className="care-panel"><div className="care-toolbar"><div><div className="care-kicker">{tr(ar,'PLAN OF ACTION','خطة العمل')}</div><h2 className="care-title" style={{margin:0}}>{tr(ar,'Treatment steps','خطوات العلاج')}</h2></div>
     {writable&&<button className="btn btn-outline" onClick={()=>openItem('new')} data-testid="button-add-plan-item"><Plus size={15}/>{tr(ar,'Add step','إضافة خطوة')}</button>}</div>
     {!q.data.items.length?<p className="care-muted">{tr(ar,'No treatment steps recorded.','لم تُسجل خطوات علاجية.')}</p>:q.data.items.map((item,i)=><div className="care-row" key={item.id} data-testid={`row-plan-item-${item.id}`}><div style={{minWidth:0}}>
      <div className="care-muted">{String(i+1).padStart(2,'0')} · {tr(ar,'Priority','الأولوية')} {item.priority} {item.toothCode&&`· ${tr(ar,'Tooth','سن')} ${item.toothCode}`}</div><strong>{item.description}</strong>{item.notes&&<div className="care-muted">{item.notes}</div>}</div>
      <div className="care-actions"><span className="care-pill">{careLabel(item.status,ar)}</span>{writable&&<button className="btn btn-outline" onClick={()=>openItem(item)} data-testid={`button-edit-plan-item-${item.id}`}>{tr(ar,'Edit','تعديل')}</button>}</div></div>)}
    </section>
   </div><aside className="care-panel" style={{alignSelf:'start'}}><div className="care-kicker">{tr(ar,'PLAN STATUS','حالة الخطة')}</div>
    <p className="care-muted">{terminal?tr(ar,'This plan is closed and read-only.','هذه الخطة مغلقة ومتاحة للقراءة فقط.'):tr(ar,'Keep the plan aligned with the care delivered.','ابقِ الخطة متوافقة مع العلاج المنفذ.')}</p>
    {writable&&<label className="care-field">{tr(ar,'Status','الحالة')}<select value={q.data.status} disabled={update.isPending} onChange={e=>changePlan({status:e.target.value as 'draft'|'active'|'completed'|'cancelled'})} data-testid="select-plan-status">{(['draft','active','completed','cancelled'] as const).map(s=><option key={s} value={s}>{careLabel(s,ar)}</option>)}</select></label>}
    {terminal&&<span className="care-pill" data-testid="status-plan-readonly">{careLabel(q.data.status,ar)}</span>}
    <div className="care-row"><span className="care-muted">{tr(ar,'Prepared by','أعدها')}</span><strong>{q.data.createdByName}</strong></div>
    <div className="care-row"><span className="care-muted">{tr(ar,'Updated','آخر تحديث')}</span><strong>{dateText(q.data.updatedAt,ar)}</strong></div>
   </aside></div>
   {saved&&<p role="status" className="care-pill" data-testid="status-plan-saved">{saved}</p>}{error&&<InlineError message={error}/>}
  </>}
  {editing&&writable&&<div className="care-dialog" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null)}}>
   <form className="care-panel care-stack" style={{width:'min(100%,500px)'}} onSubmit={saveItem}>
    <div className="care-kicker">{tr(ar,editing==='new'?'ADD TREATMENT STEP':'EDIT TREATMENT STEP',editing==='new'?'إضافة خطوة علاجية':'تعديل خطوة علاجية')}</div>
    <label className="care-field">{tr(ar,'Description','الوصف')}<input required value={description} onChange={e=>setDescription(e.target.value)} data-testid="input-plan-item-description"/></label>
    <div className="care-form"><label className="care-field">{tr(ar,'Tooth code','رمز السن')}<input value={toothCode} pattern="[1-8][1-8]" maxLength={2} onChange={e=>setToothCode(e.target.value)} data-testid="input-plan-item-tooth"/></label>
     <label className="care-field">{tr(ar,'Priority','الأولوية')}<select value={priority} onChange={e=>setPriority(Number(e.target.value))} data-testid="select-plan-item-priority"><option value={1}>1 · {tr(ar,'High','مرتفعة')}</option><option value={2}>2 · {tr(ar,'Normal','متوسطة')}</option><option value={3}>3 · {tr(ar,'Later','لاحقًا')}</option></select></label></div>
    {editing!=='new'&&<label className="care-field">{tr(ar,'Status','الحالة')}<select value={itemStatus} onChange={e=>setItemStatus(e.target.value as TreatmentPlanItemStatus)} data-testid="select-plan-item-status">{(['pending','in_progress','completed'] as const).map(s=><option key={s} value={s}>{careLabel(s,ar)}</option>)}</select></label>}
    <label className="care-field">{tr(ar,'Notes','ملاحظات')}<textarea value={itemNotes} onChange={e=>setItemNotes(e.target.value)} data-testid="input-plan-item-notes"/></label>
    <div className="care-actions"><button className="btn btn-primary" disabled={add.isPending||updateItem.isPending} data-testid="button-save-plan-item">{tr(ar,'Save step','حفظ الخطوة')}</button><button className="btn btn-outline" type="button" onClick={()=>setEditing(null)} data-testid="button-close-plan-item">{tr(ar,'Cancel','إلغاء')}</button></div>
    {error&&<InlineError message={error}/>}
   </form>
  </div>}
 </main>;
}