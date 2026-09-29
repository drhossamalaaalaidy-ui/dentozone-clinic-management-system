import { useEffect, useState } from 'react';
import {
  getDownloadPatientDocumentQueryKey,
  useDownloadPatientDocument,
  useListPatientVisits,
  getListPatientVisitsQueryKey,
  type PatientDocument,
  type StaffSession,
  type Visit,
} from '@workspace/api-client-react';
import { Download, Eye, Image, RotateCcw, ShieldCheck } from 'lucide-react';
import { InlineError, State } from '@/components/clinic-ui';
import { useLocale } from '@/lib/locale';
import { dateText, errorText, tr } from '@/lib/care';

type MediaKind = 'photo' | 'xray';

function MediaItem({
  doc, patientId, visit, writable, onStatus,
}: {
  doc: PatientDocument;
  patientId: number;
  visit?: Visit;
  writable: boolean;
  onStatus: (doc: PatientDocument) => void;
}) {
  const { language } = useLocale();
  const ar = language === 'ar';
  const file = useDownloadPatientDocument(patientId, doc.id, {
    query: {
      enabled: false,
      queryKey: getDownloadPatientDocumentQueryKey(patientId, doc.id),
      retry: false,
      staleTime: 0,
      gcTime: 0,
    },
  });
  const [failure, setFailure] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function readFile(mode: 'view' | 'download') {
    setFailure('');
    try {
      const result = await file.refetch();
      if (result.error) throw result.error;
      if (!result.data) throw Error(tr(ar, 'File unavailable', 'الملف غير متاح'));
      const url = URL.createObjectURL(result.data);
      if (mode === 'view') setPreviewUrl(url);
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = doc.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (error) {
      setFailure(errorText(error, ar));
    }
  }

  const visitLabel = visit
    ? `${dateText(visit.occurredAt, ar)} · #${visit.id}${visit.complaint ? ` · ${visit.complaint}` : ''}`
    : doc.visitId
      ? tr(ar, `Visit #${doc.visitId}`, `الزيارة #${doc.visitId}`)
      : tr(ar, 'Not linked to a visit', 'غير مرتبطة بزيارة');

  return (
    <article className="care-hub-item">
      <div>
        <strong>{doc.filename}</strong>
        <small>{visitLabel}</small>
        <small>{dateText(doc.createdAt, ar)} · {Math.ceil(doc.sizeBytes / 1024)} KB · {doc.contentType}</small>
        {doc.status !== 'active' && <small>{tr(ar, `Status: ${doc.status}`, `الحالة: ${doc.status === 'withdrawn' ? 'مسحوب' : 'بانتظار الرفع'}`)}</small>}
        {failure && <InlineError message={failure} />}
      </div>
      <div className="care-hub-actions">
        {doc.status === 'active' && <>
          <button className="btn btn-outline" type="button" onClick={() => void readFile('view')} disabled={file.isFetching}>
            <Eye size={15} />{tr(ar, 'View privately', 'عرض خاص')}
          </button>
          <button className="btn btn-outline" type="button" onClick={() => void readFile('download')} disabled={file.isFetching}>
            <Download size={15} />{tr(ar, 'Download', 'تنزيل')}
          </button>
        </>}
        {writable && doc.status === 'active' && (
          <button className="btn btn-soft" type="button" onClick={() => onStatus(doc)}>
            {tr(ar, 'Withdraw', 'سحب')}
          </button>
        )}
        {writable && doc.status === 'withdrawn' && (
          <button className="btn btn-soft" type="button" onClick={() => onStatus(doc)}>
            <RotateCcw size={15} />{tr(ar, 'Restore', 'استعادة')}
          </button>
        )}
      </div>
      {previewUrl && (
        <div className="care-dialog" role="dialog" aria-modal="true" aria-label={tr(ar, 'Private media viewer', 'عارض الملفات الخاصة')}>
          <div className="care-panel" style={{ padding: 20, width: 'min(96vw, 1000px)', maxHeight: '92dvh', overflow: 'auto' }}>
            <div className="care-hub-actions" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>{doc.filename}</strong>
              <button type="button" className="btn btn-outline" onClick={() => setPreviewUrl('')}>{tr(ar, 'Close', 'إغلاق')}</button>
            </div>
            {doc.contentType.startsWith('image/')
              ? <img src={previewUrl} alt={doc.filename} style={{ display: 'block', maxWidth: '100%', maxHeight: '75dvh', margin: '0 auto', objectFit: 'contain' }} />
              : <iframe title={doc.filename} src={previewUrl} style={{ width: '100%', height: '75dvh', border: 0 }} />}
          </div>
        </div>
      )}
    </article>
  );
}

function MediaSection({
  kind, docs, patientId, visits, writable, showInactive, onStatus, onUpload, uploading,
}: {
  kind: MediaKind;
  docs: PatientDocument[];
  patientId: number;
  visits?: Visit[];
  writable: boolean;
  showInactive: boolean;
  onStatus: (doc: PatientDocument) => void;
  onUpload?: (file: File, kind: MediaKind, visitId: string) => Promise<void>;
  uploading: boolean;
}) {
  const { language } = useLocale();
  const ar = language === 'ar';
  const [file, setFile] = useState<File | null>(null);
  const [visitId, setVisitId] = useState('');
  const [uploadError, setUploadError] = useState('');
  const visible = docs.filter((doc) => showInactive || doc.status === 'active');
  const visitById = new Map<number, Visit>();
  for (const visit of visits ?? []) visitById.set(visit.id, visit);
  const groups = new Map<string, PatientDocument[]>();
  for (const doc of visible) {
    const key = doc.visitId ? String(doc.visitId) : 'unlinked';
    groups.set(key, [...(groups.get(key) ?? []), doc]);
  }

  async function submitUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !onUpload) return;
    setUploadError('');
    try {
      await onUpload(file, kind, visitId);
      setFile(null);
      setVisitId('');
      const input = document.getElementById(`patient-media-file-${kind}`) as HTMLInputElement | null;
      if (input) input.value = '';
    } catch (error) {
      setUploadError(errorText(error, ar));
    }
  }

  return (
    <section className="care-hub-card">
      <h2><Image size={18} style={{ display: 'inline', verticalAlign: 'middle', marginInlineEnd: 8 }} />
        {kind === 'photo' ? tr(ar, 'Clinical photos', 'الصور السريرية') : tr(ar, 'X-rays', 'الأشعة السينية')}
      </h2>
      {onUpload && <form className="care-hub-form" onSubmit={submitUpload} style={{ marginBottom: 18 }}>
        <label className="care-field">{tr(ar, kind === 'photo' ? 'Add a clinical photo' : 'Add an X-ray', kind === 'photo' ? 'إضافة صورة سريرية' : 'إضافة أشعة سينية')}
          <input id={`patient-media-file-${kind}`} type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <label className="care-field">{tr(ar, 'Linked visit ID (optional)', 'رقم الزيارة المرتبطة (اختياري)')}
          <input type="number" min="1" value={visitId} onChange={(event) => setVisitId(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-outline" disabled={uploading || !file}>
          {uploading ? tr(ar, 'Uploading securely…', 'جارٍ الرفع بأمان…') : tr(ar, kind === 'photo' ? 'Upload photo' : 'Upload X-ray', kind === 'photo' ? 'رفع الصورة' : 'رفع الأشعة')}
        </button>
        {uploadError && <InlineError message={uploadError} />}
      </form>}
      {!visible.length
        ? <State kind="empty" title={tr(ar, `No ${kind === 'photo' ? 'photos' : 'X-rays'} to show`, kind === 'photo' ? 'لا توجد صور للعرض' : 'لا توجد أشعة للعرض')}
          description={tr(ar, 'Media is organized by visit and remains private to authorized staff.', 'الوسائط منظمة حسب الزيارة وتبقى خاصة بالطاقم المخوّل.')} />
        : <div className="care-hub-list">
          {[...groups.entries()].map(([key, group]) => {
            const visit = key === 'unlinked' ? undefined : visitById.get(Number(key));
            return <div key={key}>
              <h3 style={{ margin: '12px 0 4px' }}>
                {visit
                  ? tr(ar, `Visit #${visit.id} · ${dateText(visit.occurredAt, ar)}`, `الزيارة #${visit.id} · ${dateText(visit.occurredAt, ar)}`)
                  : key === 'unlinked'
                    ? tr(ar, 'No linked visit', 'لا توجد زيارة مرتبطة')
                    : tr(ar, `Visit #${key}`, `الزيارة #${key}`)}
              </h3>
              {group.map((doc) => <MediaItem key={doc.id} doc={doc} patientId={patientId} visit={visitById.get(doc.visitId ?? -1)} writable={writable} onStatus={onStatus} />)}
            </div>;
          })}
        </div>}
    </section>
  );
}

export default function PatientMedia({
  patientId, documents, session, showInactive, onStatus, onUpload, uploading = false,
}: {
  patientId: number;
  documents: PatientDocument[];
  session: StaffSession;
  showInactive: boolean;
  onStatus: (doc: PatientDocument) => void;
  onUpload?: (file: File, kind: MediaKind, visitId: string) => Promise<void>;
  uploading?: boolean;
}) {
  const visits = useListPatientVisits(patientId, {
    query: { enabled: patientId > 0, queryKey: getListPatientVisitsQueryKey(patientId) },
  });
  const { language } = useLocale();
  const ar = language === 'ar';
  const writable = ['owner', 'dentist'].includes(session.role);
  const photos = documents.filter((doc) => doc.kind === 'photo');
  const xrays = documents.filter((doc) => doc.kind === 'xray');

  return <>
    {visits.isError && <div className="care-hub-note"><ShieldCheck size={16} />{tr(ar, 'Visit labels could not be loaded; linked visit IDs are still shown.', 'تعذر تحميل تسميات الزيارة؛ ستظل أرقام الزيارة المرتبطة معروضة.')}</div>}
    <MediaSection kind="photo" docs={photos} patientId={patientId} visits={visits.data} writable={writable} showInactive={showInactive} onStatus={onStatus} onUpload={onUpload} uploading={uploading} />
    <MediaSection kind="xray" docs={xrays} patientId={patientId} visits={visits.data} writable={writable} showInactive={showInactive} onStatus={onStatus} onUpload={onUpload} uploading={uploading} />
  </>;
}