import { api, companyPath, writeRecord } from '../services/api.js';
import { validateStockItem } from '../domain/stock.js';

const requireWrite=store=>{if(!store.can('inventoryWrite'))throw new Error('Ask a manager to change stock item settings.');};
export const stockModule={
  addItem(store,item){requireWrite(store);return writeRecord(store,'stock_items',validateStockItem(item,store.state.stock_items));},
  updateItem(store,item){requireWrite(store);return writeRecord(store,'stock_items',validateStockItem(item,store.state.stock_items),true);},
  async archiveItem(store,id){requireWrite(store);await api(companyPath(store,'/stock_items/'+encodeURIComponent(id)),{method:'DELETE'});await store.refreshData();},
  async move(store,itemId,movement){
    if(!store.can('inventoryTransact'))throw new Error('You cannot record stock movements in this company.');
    const result=await api(companyPath(store,'/stock_items/'+encodeURIComponent(itemId)+'/movements'),{method:'POST',body:movement});
    await store.refreshData();return result;
  },
};
