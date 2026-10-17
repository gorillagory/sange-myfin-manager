import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {clearExpenseIntent,loadOrCreateExpenseIntent} from '../src/services/expenseIntent.js';

const first='129b13ee-0e91-4f0e-bef5-57ac1aa65fa4';
const second='bd0b79ba-6240-4d90-8f10-bfe3421b9c60';
function memoryStorage(){const values=new Map();return {
  getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),
  removeItem:key=>values.delete(key),dump:()=>JSON.stringify([...values]),
};}

test('expense create intent survives a reload without storing financial data',()=>{
  const storage=memoryStorage();
  const id=loadOrCreateExpenseIntent('company-1',{storage,randomUUID:()=>first});
  assert.equal(id,first);
  assert.equal(loadOrCreateExpenseIntent('company-1',{storage,randomUUID:()=>second}),first);
  assert.doesNotMatch(storage.dump(),/amount|description|receipt|supplier/i);
  clearExpenseIntent('company-1',first,{storage});
  assert.equal(loadOrCreateExpenseIntent('company-1',{storage,randomUUID:()=>second}),second);
});

test('a committed intent is retired before another expense starts',()=>{
  const storage=memoryStorage();
  loadOrCreateExpenseIntent('company-1',{storage,randomUUID:()=>first});
  assert.equal(loadOrCreateExpenseIntent('company-1',{storage,randomUUID:()=>second,
    committedIds:[first]}),second);
  clearExpenseIntent('company-1',first,{storage});
  assert.match(storage.dump(),new RegExp(second));
});

test('expense form retains its request identity and uploaded receipt on an ambiguous response',async()=>{
  const [component,finance]=await Promise.all([
    readFile(new URL('../src/components/dashboard/EditionExpenses.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/store/finance.js',import.meta.url),'utf8'),
  ]);
  assert.match(component,/id:requestId,description:''/);
  assert.match(component,/Store\.addExpense\(data,editing\.value\)/);
  assert.match(component,/expenseOutcomeUnknown\.value=true/);
  assert.match(component,/form\.value\.receiptUrl=uploaded\.url;form\.value\.receiptPath=uploaded\.path;file\.value=null/);
  assert.match(finance,/addExpense\(s,e,update=Boolean\(e\.version\)\)/);
});
