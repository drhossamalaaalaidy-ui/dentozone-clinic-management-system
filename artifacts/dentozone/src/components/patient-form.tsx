import { useState, type FormEvent } from 'react';
import type { Patient, PatientInput, PatientUpdate } from '@workspace/api-client-react';
import { useLocale } from '@/lib/locale';
import { InlineError } from '@/components/clinic-ui';

type FormValue = PatientInput & {status?:Patient['status']};
const textFields = [
  {title:'personal',keys:['fullName','gender','dateOfBirth','phone','whatsapp','email','address','emergencyContact','occupation','referralSource']},
  {title:'medical',keys:['allergies','medications','medicalConditions','previousSurgeries','diabetes','hypertension','heartDisease','bleedingDisorders','pregnancy','smoking']},
  {title:'dental',keys:['previousDentalTreatment','previousOrthodonticTreatment','oralHygiene','dentalComplaints','previousDentist','notes']}
] as const;
const labels:Record<string,string>={fullName:'name',dateOfBirth:'birthday',emergencyContact:'emergency',referralSource:'referral',medicalConditions:'conditions',previousSurgeries:'surgeries',bleedingDisorders:'bleeding',previousDentalTreatment:'dentalTreatment',previousOrthodonticTreatment:'orthodontic',dentalComplaints:'complaints',notes:'patientNotes'};
const booleanKeys=['diabetes','hypertension','heartDisease','bleedingDisorders','pregnancy','smoking'];
const textareaKeys=['allergies','medications','medicalConditions','previousSurgeries','previousDentalTreatment','previousOrthodonticTreatment','dentalComplaints','notes'];
export function PatientForm({patient,onSave,pending,error,administrativeOnly=false}:{patient?:Patient;onSave:(data:PatientInput|PatientUpdate)=>void;pending:boolean;error?:string;administrativeOnly?:boolean}){
  const {t}=useLocale();
  const [form,setForm]=useState<FormValue>(()=>({
    fullName:patient?.fullName||'',gender:patient?.gender||'undisclosed',phone:patient?.phone||'',
    dateOfBirth:patient?.dateOfBirth||'',whatsapp:patient?.whatsapp||'',email:patient?.email||'',address:patient?.address||'',emergencyContact:patient?.emergencyContact||'',occupation:patient?.occupation||'',referralSource:patient?.referralSource||'',
    allergies:patient?.allergies||'',medications:patient?.medications||'',medicalConditions:patient?.medicalConditions||'',previousSurgeries:patient?.previousSurgeries||'',
    diabetes:patient?.diabetes||false,hypertension:patient?.hypertension||false,heartDisease:patient?.heartDisease||false,bleedingDisorders:patient?.bleedingDisorders||false,pregnancy:patient?.pregnancy||false,smoking:patient?.smoking||false,
    previousDentalTreatment:patient?.previousDentalTreatment||'',previousOrthodonticTreatment:patient?.previousOrthodonticTreatment||'',oralHygiene:patient?.oralHygiene||'',dentalComplaints:patient?.dentalComplaints||'',previousDentist:patient?.previousDentist||'',notes:patient?.notes||'',status:patient?.status
  }));
  const set=(key:string,value:string|boolean)=>setForm(prev=>({...prev,[key]:value}));
  function submit(e:FormEvent){e.preventDefault();const data:Record<string,unknown>={...form};for(const [k,v] of Object.entries(data))if(typeof v==='string'&&v.trim()===''&&!['fullName','phone','gender','status'].includes(k))data[k]=null;if(!patient)delete data.status;if(administrativeOnly){const allowed=new Set<string>([...textFields[0].keys,'status']);for(const key of Object.keys(data))if(!allowed.has(key))delete data[key]}onSave(data as PatientInput|PatientUpdate)}
  return <form onSubmit={submit} data-testid="form-patient">
    {patient&&<div className="panel" style={{padding:23,marginBottom:18}}><label className="field">{t('status')}<select className="input" value={form.status} onChange={e=>set('status',e.target.value)} data-testid="select-patient-status">{(['active','inactive','archived'] as const).map(s=><option value={s} key={s}>{t(s)}</option>)}</select></label></div>}
    {(administrativeOnly?textFields.slice(0,1):textFields).map(section=><section key={section.title} className="panel" style={{padding:'25px clamp(18px,3vw,30px)',marginBottom:18}}><div className="section-head"><h2 style={{margin:0}}>{t(section.title)}</h2><span className="eyebrow">0{section.title==='personal'?1:section.title==='medical'?2:3}</span></div><div className="form-grid">{section.keys.map(key=>{
      const label=t((labels[key]||key) as Parameters<typeof t>[0]);
      if(booleanKeys.includes(key))return <label key={key} style={{display:'flex',alignItems:'center',gap:11,padding:'10px 13px',background:'#f6f8f3',borderRadius:10,fontSize:13,fontWeight:650,color:'#3a6263',minHeight:45}}><input type="checkbox" checked={Boolean(form[key as keyof FormValue])} onChange={e=>set(key,e.target.checked)} style={{accentColor:'#236b70',width:17,height:17}} data-testid={`checkbox-${key}`}/>{label}</label>;
      if(key==='gender')return <label className="field" key={key}>{label}<select className="input" value={form.gender} onChange={e=>set(key,e.target.value)} data-testid="select-gender">{(['female','male','other','undisclosed'] as const).map(g=><option key={g} value={g}>{t(g)}</option>)}</select></label>;
      const value=String(form[key as keyof FormValue]??'');
      return <label className="field" key={key}>{label}{textareaKeys.includes(key)?<textarea className="input textarea" value={value} onChange={e=>set(key,e.target.value)} data-testid={`input-${key}`}/>:<input className="input" value={value} onChange={e=>set(key,e.target.value)} type={key==='dateOfBirth'?'date':key==='email'?'email':'text'} inputMode={key==='phone'||key==='whatsapp'||key==='emergencyContact'?'tel':undefined} required={key==='fullName'||key==='phone'} minLength={key==='fullName'?2:key==='phone'?7:undefined} maxLength={key==='fullName'?180:key==='phone'?24:undefined} dir={key==='phone'||key==='whatsapp'||key==='email'?'ltr':undefined} data-testid={`input-${key}`}/>}</label>
    })}</div></section>)}
    {error&&<InlineError message={error}/>}<div style={{display:'flex',justifyContent:'flex-end',paddingTop:7}}><button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-patient">{pending?t(patient?'saving':'creating'):t(patient?'save':'create')}</button></div>
  </form>
}