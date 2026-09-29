import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getDownloadPatientDocumentQueryKey,
  getListPatientDocumentsQueryKey,
  useCompletePatientDocumentUpload,
  useDownloadPatientDocument,
  useListPatientDocuments,
  useRequestPatientDocumentUpload,
  useUpdatePatientDocumentStatus,
  type DocumentUploadInputContentType,
  type DocumentUploadInputKind,
  type PatientDocument,
  type StaffSession,
} from '@workspace/api-client-react';
import { Download, FilePlus2, ShieldCheck } from 'lucide-react';
import { InlineError, State } from '@/components/clinic-ui';
import PatientMedia from '@/components/patient-media';
import { useLocale } from '@/lib/locale';
import { dateText, errorText, tr } from '@/lib/care';

function DocumentRow({
  doc, patientId, writable, onStatus,
}: {
  doc: PatientDocument;
  patientId: number;
  writable: boolean;
  onStatus: (doc: PatientDocument) => void;
}) {
  const { language } = useLocale();
  const ar = language === 'ar';
  const download = useDownloadPatientDocument(patientId, doc.id, {
    query: {
      enabled: false,
      queryKey: getDownloadPatientDocumentQueryKey(patientId, doc.id),
      retry: false,
      staleTime: 0,
      gcTime: 0,
    },
  });
  const [failure, setFailure] = useState('');

  async function open() {
    setFailure('');
    try {
      const result = await download.refetch();
      if (result.error) throw result.error;
      if (!result.data) throw Error(tr(ar, 'File unavailable', 'الملف غير متاح'));
      const url = URL.createObjectURL(result.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setFailure(errorText(error, ar));
    }
  }

  return <div className="care-hub-item">
    <div>
      <strong>{doc.filename}</strong>
      <small>{tr(ar, doc.kind, doc.kind === 'consent' ? 'موافقة' : doc.kind === 'form' ? 'نموذج' : 'أخرى')} · {dateText(doc.createdAt, ar)} · {Math.ceil(doc.sizeBytes / 1024)} KB</small>
      <small>{tr(ar, `Status: ${doc.status}`, `الحالة: ${doc.status === 'withdrawn' ? 'مسحوب' : doc.status === 'pending' ? 'بانتظار الرفع' : 'نشط'}`)}
        {doc.kind === 'consent' && ` · ${doc.signedAt ? tr(ar, `Signed ${dateText(doc.signedAt, ar)}`, `تم التوقيع ${dateText(doc.signedAt, ar)}`) : tr(ar, 'Signature not recorded', 'لم يُسجَّل توقيع')}`}
      </small>
      {failure && <InlineError message={failure} />}
    </div>
    <div className="care-hub-actions">
      {doc.status === 'active' && <button className="btn btn-outline" type="button" onClick={() => void open()} disabled={download.isFetching}>
        <Download size={15} />{download.isFetching ? tr(ar, 'Opening…', 'جارٍ الفتح…') : tr(ar, 'Download', 'تنزيل')}
      </button>}
      {writable && (doc.status === 'active' || doc.status === 'withdrawn') && <button className="btn btn-soft" type="button" onClick={() => onStatus(doc)}>
        {doc.status === 'active' ? tr(ar, 'Withdraw', 'سحب') : tr(ar, 'Restore', 'استعادة')}
      </button>}
    </div>
  </div>;
}

export default function PatientDocumentsPanel({
  patientId, session, mediaOnly = false,
}: {
  patientId: number;
  session: StaffSession;
  mediaOnly?: boolean;
}) {
  const { language } = useLocale();
  const ar = language === 'ar';
  const qc = useQueryClient();
  const writable = ['owner', 'dentist'].includes(session.role);
  const docs = useListPatientDocuments(patientId, {
    query: { enabled: patientId > 0, queryKey: getListPatientDocumentsQueryKey(patientId) },
  });
  const request = useRequestPatientDocumentUpload();
  const complete = useCompletePatientDocumentUpload();
  const update = useUpdatePatientDocumentStatus();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<DocumentUploadInputKind>('consent');
  const [signed, setSigned] = useState(false);
  const [visitId, setVisitId] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PatientDocument | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  async function uploadDocument(
    uploadFile: File,
    uploadKind: DocumentUploadInputKind,
    linkedVisitId = '',
    isSigned = false,
  ) {
    const supported = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!supported.includes(uploadFile.type)) throw Error(tr(ar, 'Use a PDF, JPEG, PNG or WebP file.', 'استخدم ملف PDF أو JPEG أو PNG أو WebP.'));
    if (uploadFile.size < 1) throw Error(tr(ar, 'The file is empty.', 'الملف فارغ.'));

    setBusy(true);
    try {
      const ticket = await request.mutateAsync({
        patientId,
        data: {
          kind: uploadKind,
          filename: uploadFile.name.split(/[/\\]/).pop() || uploadFile.name,
          contentType: uploadFile.type as DocumentUploadInputContentType,
          sizeBytes: uploadFile.size,
          ...(linkedVisitId ? { visitId: Number(linkedVisitId) } : {}),
          ...(uploadKind === 'consent' && isSigned ? { signedAt: new Date().toISOString() } : {}),
        },
      });
      const response = await fetch(ticket.uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': uploadFile.type },
        body: uploadFile,
      });
      if (!response.ok) throw Error(tr(ar, 'Upload failed. The pending record can be retried with a new upload.', 'فشل الرفع. يمكن إعادة المحاولة بطلب رفع جديد.'));
      await complete.mutateAsync({ patientId, documentId: ticket.document.id, data: {} });
      await qc.invalidateQueries({ queryKey: getListPatientDocumentsQueryKey(patientId) });
    } finally {
      setBusy(false);
    }
  }

  async function submitDocument(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setUploadError('');
    try {
      await uploadDocument(file, kind, visitId, signed);
      setFile(null);
      setVisitId('');
      setSigned(false);
      const input = document.getElementById('patient-doc-file') as HTMLInputElement | null;
      if (input) input.value = '';
    } catch (error) {
      setUploadError(errorText(error, ar));
    }
  }

  async function changeStatus() {
    if (!confirm) return;
    setStatusError('');
    try {
      await update.mutateAsync({
        patientId,
        documentId: confirm.id,
        data: { status: confirm.status === 'active' ? 'withdrawn' : 'active' },
      });
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: getListPatientDocumentsQueryKey(patientId) });
    } catch (error) {
      setStatusError(errorText(error, ar));
    }
  }

  const allDocuments = docs.data ?? [];
  const visibleDocuments = allDocuments.filter((doc) => showInactive || doc.status === 'active');
  const otherDocuments = visibleDocuments.filter((doc) => doc.kind !== 'photo' && doc.kind !== 'xray');
  const uploadKinds: DocumentUploadInputKind[] = ['consent', 'form', 'other'];

  return <div className="patient-documents-panel">
    <label className="care-hub-note" style={{ margin: '0 0 16px' }}>
      <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
      {tr(ar, 'Show withdrawn and pending records', 'إظهار السجلات المسحوبة والمعلّقة')}
    </label>
    {docs.isLoading ? <State kind="loading" /> : docs.isError ? <State kind="error" onRetry={() => docs.refetch()} /> : <>
      {!mediaOnly && <div className="care-hub-grid">
        <section className="care-hub-card">
          <h2>{tr(ar, 'Patient files', 'ملفات المريض')}</h2>
          {!otherDocuments.length
            ? <State kind="empty" title={tr(ar, 'No documents to show', 'لا توجد وثائق للعرض')}
              description={tr(ar, 'Consent forms and other patient files appear here.', 'ستظهر هنا نماذج الموافقة وملفات المريض الأخرى.')} />
            : <div className="care-hub-list">{otherDocuments.map((doc) =>
              <DocumentRow key={doc.id} doc={doc} patientId={patientId} writable={writable} onStatus={setConfirm} />)}</div>}
        </section>
        <section className="care-hub-card">
          <h2><FilePlus2 size={18} style={{ display: 'inline', verticalAlign: 'middle', marginInlineEnd: 8 }} />{tr(ar, 'Add a document', 'إضافة وثيقة')}</h2>
          {writable ? <form className="care-hub-form" onSubmit={submitDocument}>
            <label className="care-field">{tr(ar, 'Document type', 'نوع الوثيقة')}
              <select value={kind} onChange={(event) => setKind(event.target.value as DocumentUploadInputKind)}>
                {uploadKinds.map((type) => <option key={type} value={type}>
                  {tr(ar, type, type === 'consent' ? 'موافقة' : type === 'form' ? 'نموذج' : 'أخرى')}
                </option>)}
              </select>
            </label>
            <label className="care-field">{tr(ar, 'File · PDF, JPEG, PNG or WebP', 'الملف · PDF أو JPEG أو PNG أو WebP')}
              <input id="patient-doc-file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </label>
            <label className="care-field">{tr(ar, 'Linked visit ID (optional)', 'رقم الزيارة المرتبطة (اختياري)')}
              <input type="number" min="1" value={visitId} onChange={(event) => setVisitId(event.target.value)} />
            </label>
            {kind === 'consent' && <label className="care-hub-note">
              <input type="checkbox" checked={signed} onChange={(event) => setSigned(event.target.checked)} />
              {tr(ar, 'I have verified this consent was signed; record the current time.', 'تحققت من توقيع هذه الموافقة؛ سجّل الوقت الحالي.')}
            </label>}
            <button className="btn btn-primary" disabled={busy || !file}>
              {busy ? tr(ar, 'Uploading securely…', 'جارٍ الرفع بأمان…') : tr(ar, 'Upload document', 'رفع الوثيقة')}
            </button>
            {uploadError && <InlineError message={uploadError} />}
          </form> : <div className="care-hub-note"><ShieldCheck size={16} />{tr(ar, 'Only dentists and owners can upload or change document status.', 'يمكن لأطباء الأسنان والمالكين فقط رفع الوثائق أو تغيير حالتها.')}</div>}
        </section>
      </div>}

      <PatientMedia
        patientId={patientId}
        documents={allDocuments}
        session={session}
        showInactive={showInactive}
        onStatus={setConfirm}
        onUpload={writable ? (photoFile, mediaKind, linkedVisitId) => uploadDocument(photoFile, mediaKind, linkedVisitId) : undefined}
        uploading={busy}
      />
    </>}

    {confirm && <div className="care-dialog" role="dialog" aria-modal="true" aria-labelledby="document-status-title">
      <div className="care-panel" style={{ padding: 24, width: 'min(100%, 460px)' }}>
        <h2 id="document-status-title">{confirm.status === 'active' ? tr(ar, 'Withdraw document?', 'سحب الوثيقة؟') : tr(ar, 'Restore document?', 'استعادة الوثيقة؟')}</h2>
        <p className="subtle"><strong>{confirm.filename}</strong></p>
        <p className="care-hub-note">{confirm.status === 'active'
          ? tr(ar, 'This will hide the record from the active list and block all future views and downloads. The private file bytes are retained for audit; this does not erase the file.', 'سيؤدي ذلك إلى إخفاء السجل من القائمة النشطة ومنع عرضه أو تنزيله. ستُحفظ بايتات الملف الخاص لأغراض التدقيق؛ ولن يُحذف الملف.')
          : tr(ar, 'Restoring makes this retained private file active and viewable/downloadable again by authorized clinical staff.', 'ستؤدي الاستعادة إلى تفعيل هذا الملف الخاص المحفوظ وإتاحته للعرض والتنزيل للطاقم السريري المخوّل.')}</p>
        <div className="care-hub-actions">
          <button className="btn btn-primary" type="button" onClick={() => void changeStatus()} disabled={update.isPending}>
            {confirm.status === 'active' ? tr(ar, 'Confirm withdrawal', 'تأكيد السحب') : tr(ar, 'Confirm restore', 'تأكيد الاستعادة')}
          </button>
          <button className="btn btn-outline" type="button" onClick={() => { setConfirm(null); setStatusError(''); }}>{tr(ar, 'Cancel', 'إلغاء')}</button>
        </div>
        {statusError && <InlineError message={statusError} />}
      </div>
    </div>}
  </div>;
}