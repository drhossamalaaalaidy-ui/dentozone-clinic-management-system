import { getGetDashboardQueryKey, getGetFinanceReportQueryKey, getGetInvoiceQueryKey, getListExpensesQueryKey, getListInventoryItemsQueryKey, getListInvoicesQueryKey, getListStockMovementsQueryKey, getListSuppliersQueryKey } from '@workspace/api-client-react';
import type { QueryClient } from '@tanstack/react-query';
import { formatMoney } from './locale';

export function toCents(value:string):number|null {
  const normalized=value.trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace('٫','.');
  if(!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole,fraction='']=normalized.split('.');
  const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(cents)?cents:null;
}
export const money=(cents:number,language:'en'|'ar')=>formatMoney(cents/100,language);
export const egp=(cents:number|null|undefined)=>cents==null?'':(cents/100).toFixed(2);
export function invalidateFinance(qc:QueryClient,id?:number){
  qc.invalidateQueries({queryKey:getListInvoicesQueryKey()});
  qc.invalidateQueries({queryKey:getListExpensesQueryKey()});
  qc.invalidateQueries({queryKey:getGetFinanceReportQueryKey()});
  qc.invalidateQueries({queryKey:getGetDashboardQueryKey()});
  if(id)qc.invalidateQueries({queryKey:getGetInvoiceQueryKey(id)});
}
export function invalidateStock(qc:QueryClient,id?:number){
  qc.invalidateQueries({queryKey:getListInventoryItemsQueryKey()});
  qc.invalidateQueries({queryKey:getGetDashboardQueryKey()});
  if(id)qc.invalidateQueries({queryKey:getListStockMovementsQueryKey(id)});
}
export function invalidateSuppliers(qc:QueryClient){
  qc.invalidateQueries({queryKey:getListSuppliersQueryKey()});
  qc.invalidateQueries({queryKey:getListExpensesQueryKey()});
  qc.invalidateQueries({queryKey:getListInventoryItemsQueryKey()});
  qc.invalidateQueries({queryKey:getGetDashboardQueryKey()});
}