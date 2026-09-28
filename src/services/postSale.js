import {api} from './api';
import {safePaidSale} from '../domain/offlinePolicy';
export function checkoutPayload(sale) {
 const {syncError,syncStatus,cachePolicyVersion,templateSnapshot,companySnapshot,...body}=safePaidSale(sale);
 return body;
}
export async function postSaleTo(_database,sale) {
 return api('/companies/'+encodeURIComponent(sale.company_id)+'/checkout',{method:'POST',body:checkoutPayload(sale)});
}
