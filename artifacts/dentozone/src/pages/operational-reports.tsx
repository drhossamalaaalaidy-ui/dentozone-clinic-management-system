import { useState } from 'react';
import { useGetClinicOperationalReport } from '@workspace/api-client-react';
import { BackLink, InlineError, PageHeading, State } from '@/components/clinic-ui';
import { cairoDay, tr } from '@/lib/care';
import { useLocale } from '@/lib/locale';

export default function OperationalReports() {
  const {language}=useLocale();
  const ar=language==='ar';
  const [from,setFrom]=useState(()=>cairoDay(new Date(Date.now()-29*86400000)));
  const [to,setTo]=useState(()=>cairoDay(new Date()));
  const [period,setPeriod]=useState({from,to});
  const report=useGetClinicOperationalReport(period);
  const valid=Boolean(from&&to&&from<=to&&(Date.parse(to)-Date.parse(from))/86400000<366);
  const stats=report.data ? [
    [tr(ar,'New patients','مرضى جدد'),report.data.newPatients],
    [tr(ar,'Visits','زيارات'),report.data.visits],
    [tr(ar,'Procedures','إجراءات'),report.data.procedures],
    [tr(ar,'Documents added','وثائق مضافة'),report.data.documents],
    [tr(ar,'Orthodontic cases opened','حالات تقويم جديدة'),report.data.orthodonticCases],
    [tr(ar,'Staff-confirmed reminders','تذكيرات أكد الموظف إرسالها'),report.data.manuallySentReminders],
  ] as const : [];
  return <main className="page care-hub">
    <BackLink href="/dashboard" label={tr(ar,'Dashboard','لوحة التحكم')}/>
    <PageHeading eyebrow={tr(ar,'CLINIC ACTIVITY','نشاط العيادة')} title={tr(ar,'Operational reports','التقارير التشغيلية')}
      subtitle={tr(ar,'Counts of clinical and scheduling activity. No financial or patient-level data.','أعداد الأنشطة الطبية والمواعيد، دون مبالغ مالية أو بيانات فردية للمرضى.')}/>
    <section className="care-hub-card">
      <form className="care-hub-actions" onSubmit={e=>{e.preventDefault();if(valid)setPeriod({from,to})}}>
        <label className="care-field">{tr(ar,'From','من')}<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
        <label className="care-field">{tr(ar,'To','إلى')}<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
        <button className="btn btn-primary" disabled={!valid} type="submit">{tr(ar,'Apply range','تطبيق الفترة')}</button>
      </form>
      {!valid&&<InlineError message={tr(ar,'Choose an ordered range of up to 366 days.','اختر فترة مرتبة لا تتجاوز ٣٦٦ يومًا.')}/>}
    </section>
    {report.isLoading?<State kind="loading"/>:report.isError?<State kind="error" onRetry={()=>report.refetch()}/>:report.data&&<>
      <p className="care-hub-meta">{tr(ar,`Inclusive range: ${period.from} – ${period.to}`,`الفترة شاملة: ${period.from} – ${period.to}`)}</p>
      <div className="care-hub-grid">
        {stats.map(([label,value])=><div className="care-hub-card" key={label}><div className="care-hub-number">{value}</div><strong>{label}</strong></div>)}
        <div className="care-hub-card"><div className="care-hub-number">{report.data.optedInPatients}</div>
          <strong>{tr(ar,'Currently opted-in patients','المرضى الموافقون حاليًا')}</strong>
          <p className="care-hub-meta">{tr(ar,'Current total, not a historical count for this date range.','إجمالي حالي، وليس عددًا تاريخيًا للفترة المحددة.')}</p>
        </div>
      </div>
      <section className="care-hub-card">
        <h2>{tr(ar,'Appointments by status','المواعيد حسب الحالة')}</h2>
        {!report.data.appointmentsByStatus.length?<State kind="empty" title={tr(ar,'No appointments in this period','لا توجد مواعيد في هذه الفترة')}/>:<div className="care-hub-list">
          {report.data.appointmentsByStatus.map(row=><div className="care-hub-item" key={row.status}><span>{tr(ar,row.status.replaceAll('_',' '),({
            booked:'محجوز',confirmed:'مؤكد',arrived:'حضر',in_progress:'جارٍ',completed:'مكتمل',cancelled:'ملغى',no_show:'لم يحضر',
          } as Record<string,string>)[row.status]||row.status)}</span><strong>{row.count}</strong></div>)}
        </div>}
      </section>
      <p className="care-hub-meta">{tr(ar,'Reminder sends are staff confirmations, not verified delivery by a messaging provider.','حالات إرسال التذكيرات تأكيدات من الموظفين، وليست إثبات تسليم من مزود رسائل.')}</p>
    </>}
  </main>;
}