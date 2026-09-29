import { Link, useParams } from 'wouter';
import type { StaffSession } from '@workspace/api-client-react';
import { BackLink, PageHeading } from '@/components/clinic-ui';
import PatientDocumentsPanel from '@/components/patient-documents-panel';
import { useLocale } from '@/lib/locale';
import { tr } from '@/lib/care';

export default function PatientDocuments({ session }: { session: StaffSession }) {
  const id = Number(useParams<{ id: string }>().id);
  const { language } = useLocale();
  const ar = language === 'ar';

  return <main className="page care-hub">
    <BackLink href={`/patients/${id}`} label={tr(ar, 'Patient profile', 'ملف المريض')} />
    <PageHeading
      eyebrow={tr(ar, 'PATIENT RECORD / PRIVATE FILES', 'سجل المريض / ملفات خاصة')}
      title={tr(ar, 'Documents & consent', 'الوثائق والموافقات')}
      subtitle={tr(ar, 'Protected files are available only to authorized clinical staff.', 'هذه الملفات متاحة فقط للطاقم الطبي المخوّل.')}
    />
    <PatientDocumentsPanel patientId={id} session={session} />
    <Link href={`/patients/${id}/clinical`} className="btn btn-outline">{tr(ar, 'Clinical record', 'السجل الطبي')}</Link>
  </main>;
}