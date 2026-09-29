import { useQueryClient } from '@tanstack/react-query';
import { getGetPatientQueryKey, getGetPatientsQueryKey, useGetPatient, useUpdatePatient, type PatientUpdate, type StaffSession } from '@workspace/api-client-react';
import { CalendarDays, Phone, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { BackLink, PageHeading, State } from '@/components/clinic-ui';
import { PatientForm } from '@/components/patient-form';
import PatientDocumentsPanel from '@/components/patient-documents-panel';
import { useLocale, formatDate } from '@/lib/locale';

export default function PatientProfile({session}:{session:StaffSession}){const params=useParams<{id:string}>();const id=Number(params.id);const {t,language}=useLocale();const qc=useQueryClient();const q=useGetPatient(id,{query:{enabled:Number.isInteger(id)&&id>0,queryKey:getGetPatientQueryKey(id)}});const update=useUpdatePatient();const canEdit=['owner','manager','reception','dentist'].includes(session.role);function save(data:PatientUpdate){update.mutate({patientId:id,data},{onSuccess:patient=>{qc.setQueryData(getGetPatientQueryKey(id),patient);qc.invalidateQueries({queryKey:getGetPatientsQueryKey()})}})}
  return <main className="page">
    <div style={{marginBottom:24}}><BackLink href="/patients" label={t('patients')}/></div>
    {!Number.isInteger(id)||id<1?<State kind="error"/>:q.isLoading?<State kind="loading"/>:q.isError?<State kind="error" onRetry={()=>q.refetch()}/>:q.data&&<>
      <PageHeading eyebrow={`${t('profile')} / ${q.data.patientCode}`} title={q.data.fullName} subtitle={`${t('registered')} ${formatDate(q.data.registrationDate,language)}`} action={['owner','manager','dentist','assistant'].includes(session.role)?<Link href={`/patients/${id}/clinical`} className="btn btn-primary" data-testid="link-patient-clinical">{language==='ar'?'السجل الطبي':'Clinical record'}</Link>:undefined}/>
      <div className="panel" style={{padding:'18px 23px',marginBottom:21,display:'flex',gap:25,flexWrap:'wrap',alignItems:'center'}}>
        <span style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'#476e6e'}}><Phone size={15}/><span dir="ltr" data-testid="text-patient-phone">{q.data.phone}</span></span>
        <span style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'#476e6e'}}><CalendarDays size={15}/>{q.data.dateOfBirth?formatDate(q.data.dateOfBirth,language):'—'}</span>
        <span className={`badge ${q.data.status==='active'?'':'muted'}`}><ShieldCheck size={12}/>{t(q.data.status)}</span>
      </div>
      <div className="care-hub-actions" style={{marginBottom:21}}>
        {['owner','manager','dentist','assistant'].includes(session.role)&&<>
          <Link href={`/patients/${id}/documents`} className="btn btn-outline">{language==='ar'?'الوثائق والموافقات':'Documents & consent'}</Link>
          <Link href={`/patients/${id}/orthodontics`} className="btn btn-outline">{language==='ar'?'حالات التقويم':'Orthodontic cases'}</Link>
          <Link href={`/patients/${id}/laboratory`} className="btn btn-outline" data-testid="link-patient-laboratory">{language==='ar'?'طلبات المعمل':'Laboratory orders'}</Link>
          <Link href={`/patients/${id}/aligners`} className="btn btn-outline" data-testid="link-patient-aligners">{language==='ar'?'القوالب الشفافة':'Aligner courses'}</Link>
          <Link href={`/patients/${id}/prescriptions`} className="btn btn-outline" data-testid="link-patient-prescriptions">{language==='ar'?'الوصفات الطبية':'Prescriptions'}</Link>
        </>}
        {['owner','manager','reception','dentist'].includes(session.role)&&<Link href={`/patients/${id}/reminder-preferences`} className="btn btn-outline">{language==='ar'?'تفضيلات التذكير':'Reminder preferences'}</Link>}
      </div>
      {['owner','manager','dentist','assistant'].includes(session.role)&&<section style={{marginBottom:24}}>
        <div className="care-hub-actions" style={{justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <h2 style={{margin:0}}>{language==='ar'?'الصور السريرية والأشعة':'Clinical photos & X-rays'}</h2>
          <Link href={`/patients/${id}/documents`} className="btn btn-outline">{language==='ar'?'إدارة الوثائق':'Manage documents'}</Link>
        </div>
        <PatientDocumentsPanel patientId={id} session={session} mediaOnly/>
      </section>}
      {canEdit?<PatientForm key={q.data.id} patient={q.data} administrativeOnly={['manager','reception'].includes(session.role)} onSave={data=>save(data as PatientUpdate)} pending={update.isPending} error={update.isError?String((update.error as Error)?.message||t('error')):undefined}/>:<div className="panel" style={{padding:25}}><p className="subtle">{t('deniedSub')}</p></div>}
    </>}
  </main>}