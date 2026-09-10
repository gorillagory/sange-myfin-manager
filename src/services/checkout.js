import { db } from '../firebase';
import { postSaleTo } from './postSale';
export const postSale = sale => postSaleTo(db, sale);
