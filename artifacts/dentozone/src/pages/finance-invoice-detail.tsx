import { useState, type FormEvent } from 'react';
import { useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useGetInvoice, useGetSession, useRecordPayment, useReversePayment, useVoidInvoice, getGetInvoiceQueryKey, type PaymentInputMethod } from '@workspace/api-client-react';
import { PageHeading, BackLink, State } from '@/components/clinic-ui';
import { DateText, Field, FinanceTabs, Input, Modal, Pair } from '@/components/ledger-ui';
import { useLocale } from '@/lib/locale';
import { invalidateFinance, money, toCents } from '@/lib/ledger';

type Correction = {
  id: number;
  entityType: string;
  entityId: number;
  action: string;
  reason: string;
  before: unknown;
  after: unknown;
  actorName: string;
  createdAt: string;
};

type InvoiceCorrections = {
  correctionHistory?: Correction[];
};

export default function FinanceInvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const invoiceId = Number(id);
  const { t, language } = useLocale();
  const qc = useQueryClient();
  const session = useGetSession();
  const q = useGetInvoice(invoiceId, {
    query: { enabled: Number.isSafeInteger(invoiceId) && invoiceId > 0, queryKey: getGetInvoiceQueryKey(invoiceId) },
  });
  const payment = useRecordPayment();
  const voidInvoice = useVoidInvoice();
  const reversePayment = useReversePayment();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentInputMethod>('cash');
  const [installment, setInstallment] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [validation, setValidation] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<{ type: 'invoice' } | { type: 'payment'; id: number } | null>(null);
  const [reason, setReason] = useState('');
  const [correctionPending, setCorrectionPending] = useState(false);
  const [correctionError, setCorrectionError] = useState('');
  const canCorrect = ['owner', 'manager', 'accountant'].includes(session.data?.role ?? '');
  const details = q.data as (typeof q.data & InvoiceCorrections) | undefined;
  const corrections = details?.correctionHistory ?? [];
  const voidedInvoice = corrections.some((event) => event.entityType === 'invoice' && event.action === 'void');
  const voidedPaymentIds = new Set(corrections
    .filter((event) => event.entityType === 'payment' && event.action === 'void')
    .map((event) => event.entityId));

  function closePayment() {
    setOpen(false);
    setAmount('');
    setMethod('cash');
    setInstallment('');
    setReference('');
    setNotes('');
    setValidation('');
    payment.reset();
  }

  function submitPayment(e: FormEvent) {
    e.preventDefault();
    const cents = toCents(amount);
    if (cents === null || cents < 1 || cents > (q.data?.balanceCents ?? 0)) {
      setValidation(t('invalidAmount'));
      return;
    }
    payment.mutate({
      invoiceId,
      data: {
        amountCents: cents,
        method,
        installmentId: installment ? Number(installment) : null,
        reference: reference || null,
        notes: notes || null,
      },
    }, { onSuccess: () => { invalidateFinance(qc, invoiceId); closePayment(); } });
  }

  async function submitCorrection(e: FormEvent) {
    e.preventDefault();
    if (!correctionTarget || reason.trim().length < 8) {
      setCorrectionError(language === 'ar' ? 'يرجى إدخال سبب من ٨ أحرف على الأقل.' : 'Enter a reason of at least 8 characters.');
      return;
    }
    setCorrectionPending(true);
    setCorrectionError('');
    try {
      if (correctionTarget.type === 'invoice') {
        await voidInvoice.mutateAsync({ invoiceId, data: { reason: reason.trim() } });
      } else {
        await reversePayment.mutateAsync({ paymentId: correctionTarget.id, data: { reason: reason.trim() } });
      }
      invalidateFinance(qc, invoiceId);
      setCorrectionTarget(null);
      setReason('');
      setCorrectionError('');
    } catch (error) {
      setCorrectionError(error instanceof Error ? error.message : t('error'));
    } finally {
      setCorrectionPending(false);
    }
  }

  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) return <main className="page"><State kind="error" /></main>;
  const i = q.data;
  const safeToVoidInvoice = Boolean(i && !voidedInvoice && i.paidCents === 0
    && i.payments.every((entry) => voidedPaymentIds.has(entry.id)));
  const correctionTitle = correctionTarget?.type === 'invoice'
    ? (language === 'ar' ? 'إلغاء الفاتورة' : 'Void invoice')
    : (language === 'ar' ? 'عكس الدفعة' : 'Reverse payment');
  return <main className="page">
    <div style={{ marginBottom: 20 }}><BackLink href="/finance" label={t('invoices')} /></div>
    <PageHeading
      eyebrow={t('finance')}
      title={`${t('invoice')} #${invoiceId}`}
      subtitle={i?.patientName}
      action={i && !voidedInvoice && i.balanceCents > 0
        ? <button className="btn btn-primary" onClick={() => setOpen(true)} data-testid="button-record-payment">{t('recordPayment')}</button>
        : undefined}
    />
    <FinanceTabs />
    {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" onRetry={() => q.refetch()} /> : i && <>
      <div className="ledger-grid">
        <div className="ledger-stat"><span>{t('total')}</span><strong>{money(i.totalCents, language)}</strong></div>
        <div className="ledger-stat"><span>{t('paid')}</span><strong>{money(i.paidCents, language)}</strong></div>
        <div className="ledger-stat"><span>{t('balance')}</span><strong>{money(i.balanceCents, language)}</strong></div>
      </div>
      <div className="ledger-split">
        <div>
          <section className="panel ledger-section">
            <h2>{t('invoice')} · <span className={`badge ${i.status === 'paid' ? '' : 'warn'}`}>
              {voidedInvoice ? (language === 'ar' ? 'ملغاة' : 'Voided') : t(i.status)}
            </span></h2>
            <Pair label={t('patients')} value={i.patientName} />
            <Pair label={t('issuedAt')} value={<DateText value={i.issuedAt} />} />
            {i.dueDate && <Pair label={t('dueDate')} value={<DateText value={i.dueDate} />} />}
            <Pair label={t('notes')} value={i.notes || '—'} />
            {canCorrect && safeToVoidInvoice && <button className="btn btn-outline" onClick={() => {
              setCorrectionTarget({ type: 'invoice' }); setCorrectionError('');
            }} data-testid="button-void-invoice">{language === 'ar' ? 'إلغاء الفاتورة' : 'Void invoice'}</button>}
          </section>
          <section className="panel ledger-section">
            <h2>{t('description')}</h2>
            {i.items.map((line) => <Pair key={line.id} label={`${line.description} × ${line.quantity}`} value={money(line.totalCents, language)} />)}
          </section>
          <section className="panel ledger-section">
            <h2>{language === 'ar' ? 'سجل التصحيحات' : 'Correction history'}</h2>
            {corrections.length ? corrections.map((event) => <div key={event.id} className="ledger-note" data-testid={`correction-history-${event.id}`}>
              <strong>{event.entityType === 'invoice'
                ? (language === 'ar' ? 'إلغاء الفاتورة' : 'Invoice void')
                : `${language === 'ar' ? 'عكس الدفعة' : 'Payment reversal'} #${event.entityId}`}</strong>
              <div>{event.reason}</div>
              <div>{event.actorName} · <DateText value={event.createdAt} /></div>
            </div>) : <p className="ledger-note">{t('noRecords')}</p>}
          </section>
        </div>
        <div>
          <section className="panel ledger-section">
            <h2>{t('installments')}</h2>
            {i.installments.length ? i.installments.map((plan) => <div key={plan.id}>
              <Pair label={<><DateText value={plan.dueDate} /> · {t(plan.status)}</>} value={`${money(plan.paidCents, language)} / ${money(plan.amountCents, language)}`} />
            </div>) : <p className="ledger-note">{t('noRecords')}</p>}
          </section>
          <section className="panel ledger-section">
            <h2>{t('payments')}</h2>
            {i.payments.length ? i.payments.map((p) => {
              const isVoided = voidedPaymentIds.has(p.id);
              return <div key={p.id}>
                <Pair label={`${t(p.method)} · ${p.reference || ''}${isVoided ? ` · ${language === 'ar' ? 'معكوسة' : 'Voided'}` : ''}`} value={money(p.amountCents, language)} />
                <div className="ledger-note"><DateText value={p.paidAt} />{p.notes && ` · ${p.notes}`}</div>
                {canCorrect && !isVoided && !voidedInvoice && <button className="btn btn-outline" onClick={() => {
                  setCorrectionTarget({ type: 'payment', id: p.id }); setCorrectionError('');
                }} data-testid={`button-void-payment-${p.id}`}>{language === 'ar' ? 'عكس الدفعة' : 'Reverse payment'}</button>}
              </div>;
            }) : <p className="ledger-note">{t('noRecords')}</p>}
          </section>
        </div>
      </div>
    </>}
    {open && i && <Modal title={t('recordPayment')} onClose={closePayment} onSubmit={submitPayment} pending={payment.isPending}
      error={validation || (payment.isError ? String((payment.error as Error).message) : '')}>
      <p className="ledger-note">{t('balance')}: <strong>{money(i.balanceCents, language)}</strong></p>
      <Field label={t('amount')}><Input value={amount} onChange={setAmount} required testId="input-payment-amount" /></Field>
      <div className="form-grid">
        <Field label={t('method')}><select className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentInputMethod)} data-testid="select-payment-method">
          <option value="cash">Cash / نقدًا</option><option value="card">Card / بطاقة</option><option value="bank_transfer">Bank transfer / تحويل بنكي</option><option value="other">Other / أخرى</option>
        </select></Field>
        <Field label={t('installments')}><select className="input" value={installment} onChange={(e) => setInstallment(e.target.value)} data-testid="select-payment-installment">
          <option value="">—</option>{i.installments.filter((plan) => plan.status !== 'paid').map((plan) => <option key={plan.id} value={plan.id}>{money(plan.amountCents - plan.paidCents, language)} · {plan.dueDate}</option>)}
        </select></Field>
      </div>
      <div className="form-grid">
        <Field label={t('reference')}><Input value={reference} onChange={setReference} testId="input-payment-reference" /></Field>
        <Field label={t('notes')}><Input value={notes} onChange={setNotes} testId="input-payment-notes" /></Field>
      </div>
    </Modal>}
    {correctionTarget && <Modal title={correctionTitle} onClose={() => {
      if (!correctionPending) { setCorrectionTarget(null); setReason(''); setCorrectionError(''); }
    }} onSubmit={submitCorrection} pending={correctionPending} error={correctionError}>
      <p className="ledger-note">{language === 'ar'
        ? 'سيتم حفظ السجل الأصلي وتسجيل سبب التصحيح مع لقطة قبل وبعد.'
        : 'The original record is retained. Your reason and before/after values will be audited.'}</p>
      <Field label={language === 'ar' ? 'سبب التصحيح' : 'Correction reason'}>
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={8} maxLength={1000} rows={4} data-testid="input-correction-reason" />
      </Field>
    </Modal>}
  </main>;
}