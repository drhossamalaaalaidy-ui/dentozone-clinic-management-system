import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListInvoices, useCreateInvoice, useSearchBillingPatients, getSearchBillingPatientsQueryKey, type InvoiceLineInput, type InstallmentInput } from '@workspace/api-client-react';
import { Link, useLocation } from 'wouter';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeading } from '@/components/clinic-ui';
import { DateText, Field, FinanceTabs, Input, Modal, QueryState } from '@/components/ledger-ui';
import { useLocale } from '@/lib/locale';
import { invalidateFinance, money, toCents } from '@/lib/ledger';

type Line={description:string;quantity:string;price:string};
type Plan={date:string;amount:string};
const freshLine=():Line=>({description:'',quantity:'1',price:''});
export default function FinanceInvoices(){
  const {t,language}=useLocale();const [,navigate]=useLocation();const qc=useQueryClient();
  const [page,setPage]=useState(0);const [filterPatientId,setFilterPatientId]=useState('');
  const filteredId=Number(filterPatientId);
  const q=useListInvoices({limit:26,offset:page*25,patientId:filterPatientId&&Number.isSafeInteger(filteredId)&&filteredId>0?filteredId:undefined});const create=useCreateInvoice();
  const [open,setOpen]=useState(false);const [patientSearch,setPatientSearch]=useState('');const [patientId,setPatientId]=useState('');const [lines,setLines]=useState<Line[]>([freshLine()]);const [plans,setPlans]=useState<Plan[]>([]);const [due,setDue]=useState('');const [notes,setNotes]=useState('');const [validation,setValidation]=useState('');
  const billingSearch={search:patientSearch.trim(),limit:20};
  const patients=useSearchBillingPatients(billingSearch,{query:{enabled:open&&billingSearch.search.length>=2,queryKey:getSearchBillingPatientsQueryKey(billingSearch)}});
  function close(){setOpen(false);setPatientSearch('');setPatientId('');setLines([freshLine()]);setPlans([]);setDue('');setNotes('');setValidation('');create.reset()}
  function submit(e:FormEvent){e.preventDefault();const id=Number(patientId);const items:InvoiceLineInput[]=[];const installments:InstallmentInput[]=[];
    for(const line of lines){const cents=toCents(line.price);if(!line.description.trim()||!Number.isSafeInteger(Number(line.quantity))||Number(line.quantity)<1||cents===null){setValidation(t('invalidAmount'));return}items.push({description:line.description.trim(),quantity:Number(line.quantity),unitPriceCents:cents})}
    for(const plan of plans){const cents=toCents(plan.amount);if(!plan.date||cents===null||cents<1){setValidation(t('invalidAmount'));return}installments.push({dueDate:plan.date,amountCents:cents})}
    if(!Number.isSafeInteger(id)||id<1){setValidation(t('patientId'));return}
    create.mutate({data:{patientId:id,items,installments,dueDate:due||null,notes:notes||null}},{onSuccess:invoice=>{setPage(0);invalidateFinance(qc,invoice.id);close();navigate(`/finance/invoices/${invoice.id}`)}})
  }
  return <main className="page"><PageHeading eyebrow={t('finance')} title={t('invoices')} subtitle={language==='ar'?'فواتير المرضى وما تبقى من كل رصيد.':'Patient invoices and what remains on every balance.'} action={<button className="btn btn-primary" onClick={()=>setOpen(true)} data-testid="button-new-invoice"><Plus size={16}/>{t('newInvoice')}</button>}/><FinanceTabs/>
    <div className="ledger-toolbar"><Field label={t('patientId')}><Input value={filterPatientId} onChange={v=>{setFilterPatientId(v);setPage(0)}} type="number" min="1" testId="input-filter-invoices-patient-id" placeholder={t('optional')}/></Field></div>
    <QueryState loading={q.isLoading} error={q.isError} empty={!q.data?.length} retry={()=>q.refetch()}/>{!!q.data?.length&&<div className="panel ledger-list">{q.data.slice(0,25).map(i=><Link className="ledger-row" href={`/finance/invoices/${i.id}`} key={i.id} data-testid={`link-invoice-${i.id}`}><div><strong>{i.patientName}</strong><small>#{i.id} · <DateText value={i.issuedAt}/></small><span className={`badge ${i.status==='paid'?'':'warn'}`}>{t(i.status)}</span></div><div style={{textAlign:'end'}}><div className="ledger-money">{money(i.balanceCents,language)}</div><small>{t('balance')} / {money(i.totalCents,language)}</small></div></Link>)}<div style={{padding:'15px 22px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}><span className="subtle">{t('page')} {page+1}</span><div style={{display:'flex',gap:8}}><button className="btn btn-outline" disabled={page===0||q.isFetching} onClick={()=>setPage(n=>Math.max(0,n-1))} data-testid="button-previous-invoices">{t('previous')}</button><button className="btn btn-outline" disabled={q.data.length<=25||q.isFetching} onClick={()=>setPage(n=>n+1)} data-testid="button-next-invoices">{t('next')}</button></div></div></div>}
    {open&&<Modal title={t('newInvoice')} onClose={close} onSubmit={submit} pending={create.isPending} error={validation|| (create.isError?String((create.error as Error).message):'')}>
      <Field label={t('searchPatients')}><Input value={patientSearch} onChange={v=>{setPatientSearch(v);setPatientId('')}} testId="input-find-invoice-patient" placeholder={t('searchPlaceholder')}/></Field>
      {patients.isLoading&&<div className="skeleton" style={{height:42}}/>}{patients.isError&&<p className="ledger-note" role="alert">{t('error')}</p>}
      {!!patients.data?.length&&<Field label={t('patients')}><select className="input" value={patientId} onChange={e=>setPatientId(e.target.value)} required data-testid="select-invoice-patient"><option value="">—</option>{patients.data.map(p=><option value={p.id} key={p.id}>{p.fullName} · {p.patientCode}</option>)}</select></Field>}
      <Field label={t('patientId')}><Input value={patientId} onChange={setPatientId} type="number" min="1" required testId="input-invoice-patient-id"/></Field>
      <div className="eyebrow">{t('description')} / {t('unitPrice')}</div>{lines.map((line,index)=><div className="ledger-line" key={index}><Field label={t('description')}><Input value={line.description} onChange={v=>setLines(a=>a.map((x,j)=>j===index?{...x,description:v}:x))} required testId={`input-line-description-${index}`}/></Field><Field label={t('quantity')}><Input value={line.quantity} onChange={v=>setLines(a=>a.map((x,j)=>j===index?{...x,quantity:v}:x))} type="number" min="1" step="1" required testId={`input-line-quantity-${index}`}/></Field><Field label={t('unitPrice')}><Input value={line.price} onChange={v=>setLines(a=>a.map((x,j)=>j===index?{...x,price:v}:x))} type="text" required testId={`input-line-price-${index}`}/></Field><button type="button" className="btn btn-outline" disabled={lines.length===1} onClick={()=>setLines(a=>a.filter((_,j)=>j!==index))} aria-label={t('remove')} data-testid={`button-remove-line-${index}`}><Trash2 size={16}/></button></div>)}
      <button type="button" className="btn btn-soft" onClick={()=>setLines(a=>[...a,freshLine()])} data-testid="button-add-line"><Plus size={15}/>{t('addLine')}</button>
      <div className="form-grid"><Field label={t('dueDate')}><Input value={due} onChange={setDue} type="date" testId="input-invoice-due"/></Field><Field label={t('notes')}><Input value={notes} onChange={setNotes} testId="input-invoice-notes"/></Field></div>
      <div className="eyebrow">{t('installments')} · {t('optional')}</div>{plans.map((plan,index)=><div className="ledger-line" key={index}><Field label={t('dueDate')}><Input value={plan.date} onChange={v=>setPlans(a=>a.map((x,j)=>j===index?{...x,date:v}:x))} type="date" required testId={`input-installment-date-${index}`}/></Field><Field label={t('amount')}><Input value={plan.amount} onChange={v=>setPlans(a=>a.map((x,j)=>j===index?{...x,amount:v}:x))} required testId={`input-installment-amount-${index}`}/></Field><button type="button" className="btn btn-outline" onClick={()=>setPlans(a=>a.filter((_,j)=>j!==index))} data-testid={`button-remove-installment-${index}`}>{t('remove')}</button></div>)}
      <button type="button" className="btn btn-soft" onClick={()=>setPlans(a=>[...a,{date:'',amount:''}])} data-testid="button-add-installment"><Plus size={15}/>{t('addInstallment')}</button>
    </Modal>}
  </main>
}