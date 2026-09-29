import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { getGetPatientQueryKey, getGetPatientReminderPreferencesQueryKey, getGetAppointmentQueryKey, getListRemindersQueryKey, getListReminderTemplatesQueryKey, useGetPatient, useGetPatientReminderPreferences, useGetAppointment, useListAppointments, useListReminders, useListReminderTemplates, useCreateReminderTemplate, useUpdateReminderTemplate, useCreateAppointmentReminderDraft, useMarkReminderSent, type Reminder, type ReminderTemplate, type ReminderTemplateInputChannel, type StaffSession } from '@workspace/api-client-react';
import { BackLink, InlineError, PageHeading, State } from '@/components/clinic-ui';
import { useLocale } from '@/lib/locale';
import { cairoDay, cairoISO, dateText, errorText, tr } from '@/lib/care';

function Delivery({reminder,onSent}:{reminder:Reminder;onSent:()=>void}){
 const {language}=useLocale(),ar=language==='ar';
  const patient=useGetPatient(reminder.patientId,{query:{enabled:false,queryKey:getGetPatientQueryKey(reminder.patientId),retry:false}});
  const preference=useGetPatientReminderPreferences(reminder.patientId,{query:{enabled:false,retry:false,queryKey:getGetPatientReminderPreferencesQueryKey(reminder.patientId)}});
  const appointment=useGetAppointment(reminder.appointmentId,{query:{enabled:false,retry:false,queryKey:getGetAppointmentQueryKey(reminder.appointmentId)}});
  const [copied,setCopied]=useState(false),[verifiedUntil,setVerifiedUntil]=useState(0),[failure,setFailure]=useState('');
  useEffect(()=>{
    if(!verifiedUntil)return;
    const timer=setTimeout(()=>setVerifiedUntil(0),Math.max(0,verifiedUntil-Date.now()));
    const clear=()=>setVerifiedUntil(0);
    window.addEventListener('focus',clear);
    return ()=>{clearTimeout(timer);window.removeEventListener('focus',clear)};
  },[verifiedUntil]);
  const ready=reminder.status==='draft'&&verifiedUntil>Date.now();
  function destinationFor(contact:string){
    if(reminder.channel==='whatsapp')return `https://wa.me/${contact.replace(/\D/g,'')}?text=${encodeURIComponent(reminder.renderedMessage)}`;
    if(reminder.channel==='sms')return `sms:${contact}?body=${encodeURIComponent(reminder.renderedMessage)}`;
    return `mailto:${contact}?body=${encodeURIComponent(reminder.renderedMessage)}`;
  }
  async function verify(){
    setVerifiedUntil(0);setFailure('');
    try{
      const [consent,booking,identity]=await Promise.all([preference.refetch(),appointment.refetch(),patient.refetch()]);
      if(reminder.status!=='draft'||consent.error||!consent.data?.optIn||consent.data.channel!==reminder.channel
        ||booking.error||!booking.data||booking.data.patientId!==reminder.patientId
        ||['cancelled','completed','no_show'].includes(booking.data.status)
        ||new Date(booking.data.startsAt)<=new Date()||identity.error||!identity.data){
        throw Error(tr(ar,'Consent, channel or appointment changed. Do not send this draft.','تغيّرت الموافقة أو القناة أو الموعد. لا ترسل هذه المسودة.'));
      }
      const contact=reminder.channel==='whatsapp'?(identity.data.whatsapp||identity.data.phone):reminder.channel==='sms'?identity.data.phone:identity.data.email;
      if(!contact)throw Error(tr(ar,'No contact is available for this channel.','لا توجد وسيلة تواصل لهذه القناة.'));
      setVerifiedUntil(Date.now()+10000);
      return contact;
    }catch(e){setFailure(errorText(e,ar));return null}
  }
  async function openChannel(){
    const contact=await verify();
    if(contact)window.location.assign(destinationFor(contact));
  }
  async function copyMessage(){
    if(!await verify())return;
    try{await navigator.clipboard.writeText(reminder.renderedMessage);setCopied(true)}
    catch(e){setFailure(errorText(e,ar))}
  }
  return <div className="care-hub-item"><div style={{width:'100%'}}>
    <strong>{tr(ar,'Appointment','موعد')} #{reminder.appointmentId} · {reminder.channel}</strong>
    <small>{dateText(reminder.createdAt,ar)} · {reminder.status==='staff_confirmed_sent'?tr(ar,'Staff confirmed sent','أكد الموظف الإرسال'):reminder.status==='draft'?tr(ar,'Draft · not sent','مسودة · لم تُرسل'):tr(ar,'Cancelled','ملغاة')}</small>
    {(ready||reminder.status==='staff_confirmed_sent')&&<div className="care-hub-preview" dir="auto" style={{margin:'12px 0'}}>{reminder.renderedMessage}</div>}
    {reminder.status==='draft'&&<>
      {!ready&&<button className="btn btn-outline" onClick={verify} disabled={patient.isFetching||preference.isFetching||appointment.isFetching}>{tr(ar,'Check current consent & review draft','تحقق من الموافقة الحالية وراجع المسودة')}</button>}
      {ready&&<div className="care-hub-actions">
        <button className="btn btn-outline" onClick={openChannel}>{reminder.channel==='whatsapp'?'WhatsApp':reminder.channel==='sms'?'SMS':tr(ar,'Email','البريد الإلكتروني')}</button>
        <button className="btn btn-outline" onClick={copyMessage}>{copied?tr(ar,'Copied','نُسخت'):tr(ar,'Copy message','نسخ الرسالة')}</button>
        <button className="btn btn-primary" onClick={async()=>{if(await verify())onSent()}}>{tr(ar,'Confirm I sent this','تأكيد أنني أرسلتها')}</button>
      </div>}
      <p className="care-hub-meta">{tr(ar,'Consent is checked again before opening or copying a message. Only confirm after sending it yourself; delivery is not provider-verified.','يُتحقق من الموافقة مرة أخرى قبل فتح الرسالة أو نسخها. أكد فقط بعد إرسالها بنفسك؛ التسليم غير مثبت من مزود الرسائل.')}</p>
    </>}
    {failure&&<InlineError message={failure}/>}
  </div></div>;
}
export default function Reminders({session}:{session:StaffSession}){
 const {language}=useLocale(),ar=language==='ar',qc=useQueryClient(),editor=['owner','manager'].includes(session.role);
 const [tab,setTab]=useState<'outreach'|'templates'>('outreach'),[error,setError]=useState(''),[selectedAppointment,setSelectedAppointment]=useState(''),[selectedTemplate,setSelectedTemplate]=useState(''),[editing,setEditing]=useState<ReminderTemplate|null>(null),[formOpen,setFormOpen]=useState(false),[title,setTitle]=useState(''),[bodyEn,setBodyEn]=useState(''),[bodyAr,setBodyAr]=useState(''),[channel,setChannel]=useState<ReminderTemplateInputChannel>('whatsapp'),[confirm,setConfirm]=useState<Reminder|null>(null);
  const from=cairoISO(`${cairoDay(new Date())}T00:00`),to=cairoISO(`${cairoDay(new Date(Date.now()+31*86400000))}T00:00`);
  const appointments=useListAppointments({from,to}),templates=useListReminderTemplates(),reminders=useListReminders(undefined,{query:{queryKey:getListRemindersQueryKey(),refetchInterval:10000,refetchOnWindowFocus:'always'}});
  const createTemplate=useCreateReminderTemplate(),updateTemplate=useUpdateReminderTemplate(),draft=useCreateAppointmentReminderDraft({request:{headers:{'Accept-Language':language}}}),mark=useMarkReminderSent();
 const upcoming=appointments.data?.filter(a=>new Date(a.startsAt)>new Date()&&!['cancelled','completed','no_show'].includes(a.status))||[];
 function begin(t?:ReminderTemplate){setEditing(t||null);setTitle(t?.title||'');setBodyEn(t?.bodyEn||'');setBodyAr(t?.bodyAr||'');setChannel(t?.channel||'whatsapp');setError('');setFormOpen(true)}
 async function saveTemplate(e:React.FormEvent){e.preventDefault();setError('');try{if(editing)await updateTemplate.mutateAsync({templateId:editing.id,data:{title:title.trim(),bodyEn:bodyEn.trim(),bodyAr:bodyAr.trim(),channel}});else await createTemplate.mutateAsync({data:{title:title.trim(),bodyEn:bodyEn.trim(),bodyAr:bodyAr.trim(),channel,active:true}});void qc.invalidateQueries({queryKey:getListReminderTemplatesQueryKey()});setFormOpen(false)}catch(e){setError(errorText(e,ar))}}
 async function toggle(t:ReminderTemplate){setError('');try{await updateTemplate.mutateAsync({templateId:t.id,data:{active:!t.active}});void qc.invalidateQueries({queryKey:getListReminderTemplatesQueryKey()})}catch(e){setError(errorText(e,ar))}}
 async function createDraft(e:React.FormEvent){e.preventDefault();setError('');try{await draft.mutateAsync({appointmentId:Number(selectedAppointment),data:{templateId:Number(selectedTemplate)}});void qc.invalidateQueries({queryKey:getListRemindersQueryKey()});setSelectedAppointment('');setSelectedTemplate('')}catch(e){setError(errorText(e,ar))}}
 async function confirmSent(){if(!confirm)return;setError('');try{await mark.mutateAsync({reminderId:confirm.id});void qc.invalidateQueries({queryKey:getListRemindersQueryKey()});setConfirm(null)}catch(e){setError(errorText(e,ar))}}
 return <main className="page care-hub"><BackLink href="/dashboard" label={tr(ar,'Dashboard','لوحة التحكم')}/><PageHeading eyebrow={tr(ar,'CLINIC OUTREACH','التواصل من العيادة')} title={tr(ar,'Appointment reminders','تذكيرات المواعيد')} subtitle={tr(ar,'A thoughtful message, sent by a person.','رسالة مدروسة يرسلها أحد أفراد الفريق.')}/><div className="care-hub-actions"><button className={`btn ${tab==='outreach'?'btn-primary':'btn-outline'}`} onClick={()=>setTab('outreach')}>{tr(ar,'Outreach','التواصل')}</button><button className={`btn ${tab==='templates'?'btn-primary':'btn-outline'}`} onClick={()=>setTab('templates')}>{tr(ar,'Templates','القوالب')}</button></div>{error&&!formOpen&&!confirm&&<InlineError message={error}/>}
 {tab==='outreach'?<div className="care-hub-grid"><section className="care-hub-card"><h2>{tr(ar,'Prepare a reminder','تجهيز تذكير')}</h2><p className="care-hub-note">{tr(ar,'Only appointments with patient consent and an active template matching their preferred channel can be drafted.','يمكن إنشاء مسودة فقط لموعد لديه موافقة المريض وقالب نشط يطابق قناة التواصل المفضلة.')}</p><form className="care-hub-form" onSubmit={createDraft}><label className="care-field">{tr(ar,'Upcoming appointment · next 30 days','موعد قادم · خلال ٣٠ يومًا')}<select required value={selectedAppointment} onChange={e=>setSelectedAppointment(e.target.value)}><option value="">{tr(ar,'Select appointment','اختر موعدًا')}</option>{upcoming.map(a=><option key={a.id} value={a.id}>{a.patientName} · {dateText(a.startsAt,ar,{hour:'2-digit',minute:'2-digit'})} · #{a.id}</option>)}</select></label>{appointments.isLoading?<State kind="loading"/>:appointments.isError?<State kind="error" onRetry={()=>appointments.refetch()}/>:upcoming.length===0&&<p className="care-hub-meta">{tr(ar,'No upcoming appointments in this period.','لا توجد مواعيد قادمة في هذه الفترة.')}</p>}<label className="care-field">{tr(ar,'Message template','قالب الرسالة')}<select required value={selectedTemplate} onChange={e=>setSelectedTemplate(e.target.value)}><option value="">{tr(ar,'Select template','اختر قالبًا')}</option>{templates.data?.filter(t=>t.active).map(t=><option key={t.id} value={t.id}>{t.title} · {t.channel}</option>)}</select></label>{templates.isError&&<State kind="error" onRetry={()=>templates.refetch()}/>}<button className="btn btn-primary" disabled={draft.isPending||!selectedAppointment||!selectedTemplate}>{tr(ar,'Create & review draft','إنشاء المسودة ومراجعتها')}</button></form></section><section className="care-hub-card"><h2>{tr(ar,'Message queue','قائمة الرسائل')}</h2>{reminders.isLoading?<State kind="loading"/>:reminders.isError?<State kind="error" onRetry={()=>reminders.refetch()}/>:!reminders.data?.length?<State kind="empty" title={tr(ar,'No reminders yet','لا توجد تذكيرات بعد')} description={tr(ar,'Draft a reminder for an opted-in patient’s upcoming appointment.','أنشئ مسودة لموعد قادم لمريض وافق على التذكيرات.')}/>:<div className="care-hub-list">{reminders.data.map(r=><Delivery key={r.id} reminder={r} onSent={()=>setConfirm(r)}/>)}</div>}</section></div>:<section className="care-hub-card"><div className="care-hub-actions" style={{justifyContent:'space-between',alignItems:'center'}}><h2>{tr(ar,'Message templates','قوالب الرسائل')}</h2>{editor&&<button className="btn btn-primary" onClick={()=>begin()}>{tr(ar,'New template','قالب جديد')}</button>}</div><p className="care-hub-meta">{tr(ar,'Use {patient_name}, {date}, {time}, and {doctor} for rendered appointment details. Disabling a template retires it without deleting its history.','استخدم {patient_name} و{date} و{time} و{doctor} لعرض تفاصيل الموعد. تعطيل القالب يحفظ سجل استخدامه.')}</p>{templates.isLoading?<State kind="loading"/>:templates.isError?<State kind="error" onRetry={()=>templates.refetch()}/>:!templates.data?.length?<State kind="empty" title={tr(ar,'No templates yet','لا توجد قوالب بعد')}/>:<div className="care-hub-list">{templates.data.map(t=><div className="care-hub-item" key={t.id}><div><strong>{t.title} <span className={`badge ${t.active?'':'muted'}`}>{t.active?tr(ar,'Active','نشط'):tr(ar,'Inactive','معطّل')}</span></strong><small>{t.channel}</small><p dir="auto">{ar?t.bodyAr:t.bodyEn}</p></div>{editor&&<div className="care-hub-actions"><button className="btn btn-outline" onClick={()=>begin(t)}>{tr(ar,'Edit','تعديل')}</button><button className="btn btn-soft" onClick={()=>toggle(t)} disabled={updateTemplate.isPending}>{t.active?tr(ar,'Disable','تعطيل'):tr(ar,'Activate','تفعيل')}</button></div>}</div>)}</div>}</section>}
 {formOpen&&<div className="care-dialog"><form className="care-panel care-hub-form" style={{padding:24,width:'min(100%,540px)',maxHeight:'90dvh',overflowY:'auto'}} onSubmit={saveTemplate}><h2>{editing?tr(ar,'Edit template','تعديل القالب'):tr(ar,'New template','قالب جديد')}</h2><label className="care-field">{tr(ar,'Title','العنوان')}<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="care-field">{tr(ar,'Channel','القناة')}<select value={channel} onChange={e=>setChannel(e.target.value as ReminderTemplateInputChannel)}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">{tr(ar,'Email','البريد الإلكتروني')}</option></select></label><label className="care-field">{tr(ar,'English message','الرسالة الإنجليزية')}<textarea required rows={4} value={bodyEn} onChange={e=>setBodyEn(e.target.value)}/></label><label className="care-field">{tr(ar,'Arabic message','الرسالة العربية')}<textarea required rows={4} dir="rtl" value={bodyAr} onChange={e=>setBodyAr(e.target.value)}/></label>{error&&<InlineError message={error}/>}<div className="care-hub-actions"><button className="btn btn-primary" disabled={createTemplate.isPending||updateTemplate.isPending}>{tr(ar,'Save template','حفظ القالب')}</button><button className="btn btn-outline" type="button" onClick={()=>setFormOpen(false)}>{tr(ar,'Cancel','إلغاء')}</button></div></form></div>}
 {confirm&&<div className="care-dialog"><div className="care-panel care-hub-form" style={{padding:24,width:'min(100%,430px)'}}><h2>{tr(ar,'Confirm manual send','تأكيد الإرسال اليدوي')}</h2><p>{tr(ar,'Did you actually send this message? This records a staff confirmation, not verified delivery by WhatsApp, SMS or email.','هل أرسلت هذه الرسالة فعلاً؟ هذا يسجل تأكيد الموظف ولا يثبت وصولها من واتساب أو الرسائل أو البريد.')}</p>{error&&<InlineError message={error}/>}<div className="care-hub-actions"><button className="btn btn-primary" disabled={mark.isPending} onClick={confirmSent}>{tr(ar,'Yes, I sent it','نعم، أرسلتها')}</button><button className="btn btn-outline" onClick={()=>setConfirm(null)}>{tr(ar,'Not yet','ليس بعد')}</button></div></div></div>}<Link href="/patients" className="btn btn-outline">{tr(ar,'Patients','المرضى')}</Link></main>
}