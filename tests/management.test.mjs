import test from 'node:test';
import assert from 'node:assert/strict';
import { companyPayload, userPayload, eligibleAdministrators, matchesPeople, isArchived } from '../src/domain/management.js';

test('company updates prefer the current tax rate, preserve receipt settings, and exclude lifecycle metadata', () => {
  const source = { id:'company-a', name:' A shop ', archived:true, archived_at:'2026-09-12', created_at:'2026-01-01', preferences:{ tax:6, taxRate:8, currency:' RM ', receiptFooter:'Thank you', paperWidth:'80' } };
  const result = companyPayload(source);
  assert.equal(result.preferences.taxRate,8);
  assert.equal(result.preferences.tax,8);
  assert.equal(result.preferences.receiptFooter,'Thank you');
  assert.equal(result.preferences.paperWidth,'80');
  assert.equal(result.preferences.currency,'RM');
  assert.equal(result.name,'A shop');
  assert.equal(Object.hasOwn(result,'archived'),false);
  assert.equal(Object.hasOwn(result,'created_at'),false);
  assert.equal(source.preferences.tax,6);
  assert.equal(companyPayload({name:'Legacy',preferences:{tax:6}}).preferences.taxRate,6);
  assert.equal(companyPayload({name:'Zero',preferences:{tax:6,taxRate:0}}).preferences.tax,0);
});
test('editing an account preserves suspension, excludes password and metadata, and clears company scope for owners', () => {
  const edit = userPayload({ username:' Person ',email:'A@EXAMPLE.COM',role:'company_admin',company_id:'a',disabled:true,password:'must-not-resubmit',created_at:'2026' },true);
  assert.equal(edit.disabled,true);
  assert.equal(edit.company_id,'a');
  assert.equal(edit.email,'a@example.com');
  assert.equal(Object.hasOwn(edit,'password'),false);
  assert.equal(Object.hasOwn(edit,'created_at'),false);
  assert.equal(userPayload({...edit,role:'super'},true).company_id,'');
});
test('enrollment only offers active unassigned non-owner accounts', () => {
  const users = [
    {id:'metadata-only',login_available:false,email:'metadata@example.com',role:null,company_id:'',disabled:false},
    {id:'history',email:'',role:null,company_id:'',disabled:false},
    {id:'eligible',login_available:true,email:'eligible@example.com',role:null,company_id:'',disabled:false},
    {id:'suspended',login_available:true,email:'suspended@example.com',role:null,company_id:'',disabled:true},
    {id:'owner',login_available:true,email:'owner@example.com',role:'super',company_id:'',disabled:false},
    {id:'assigned',login_available:true,email:'assigned@example.com',role:'company_user',company_id:'a',disabled:false},
  ];
  assert.deepEqual(eligibleAdministrators(users).map(user=>user.id),['eligible']);
});
test('directory filters combine tenant, role, search and suspension without dropping disabled assignments', () => {
  const users = [
    {id:'a',username:'Ada',email:'ADA@example.com',role:'company_admin',company_id:'a',disabled:true},
    {id:'b',username:'Ada',email:'ada2@example.com',role:'company_admin',company_id:'b',disabled:false},
    {id:'c',username:'Unassigned',email:'c@example.com',role:null,company_id:'',disabled:true},
  ];
  assert.deepEqual(matchesPeople(users,{query:' ada@',companyId:'a',status:'disabled',role:'company_admin'}).map(user=>user.id),['a']);
  assert.deepEqual(matchesPeople(users,{status:'active'}).map(user=>user.id),['b']);
  assert.deepEqual(matchesPeople(users,{companyId:'unassigned'}).map(user=>user.id),['c']);
  assert.equal(isArchived({archived_at:'2026-09-12'}),true);
  assert.equal(isArchived({archived_at:null}),false);
});

test('a new-company dialog can initialize from an explicit null selection', () => {
  const payload = companyPayload(null);
  assert.equal(payload.name, '');
  assert.equal(payload.preferences.currency, 'RM');
  assert.equal(payload.preferences.taxRate, 0);
  assert.equal(Object.hasOwn(payload, 'id'), false);
});
