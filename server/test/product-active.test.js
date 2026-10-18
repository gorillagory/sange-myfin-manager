import assert from 'node:assert/strict';
import test from 'node:test';
import { publicProduct } from '../src/access.js';
import { product, parse } from '../src/validation.js';
import { preserveProductActive, productIsActive, unpublishInactiveProduct } from '../src/product-availability.js';

const legacyProduct = {
  name:'Latte', sku:'LATTE', price:9, cost:3, stock:0, trackStock:false, variants:[],
};

test('product validation and staff projections default legacy products active while preserving explicit inactive state', () => {
  assert.equal(parse(product, legacyProduct).active, true);
  assert.equal(parse(product, { ...legacyProduct, active:false }).active, false);
  assert.throws(() => parse(product, { ...legacyProduct, active:'false' }), /invalid_input/);
  assert.equal(publicProduct({ ...legacyProduct, id:'latte' }, { role:'operator' }).active, true);
  assert.equal(publicProduct({ ...legacyProduct, id:'latte', active:false }, { role:'operator' }).active, false);
  assert.equal(productIsActive(undefined), true);
  assert.equal(productIsActive({ active:false }), false);
});

test('a cached legacy editor cannot reactivate an inactive product by omitting active', () => {
  const update = { id:'latte', name:'Latte' };
  assert.deepEqual(preserveProductActive(update, { active:false }, true), { ...update, active:false });
  assert.deepEqual(preserveProductActive(update, {}, true), { ...update, active:true });
  assert.equal(preserveProductActive(update, { active:false }, false), update);
  assert.equal(preserveProductActive({ ...update, active:true }, { active:false }, true).active, true);
});

test('deactivating a product removes its storefront parent and option projections in the same transaction', async () => {
  const calls=[];
  const c={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[]};}};
  assert.equal(await unpublishInactiveProduct(c,'company-a',{id:'latte',active:true}),false);
  assert.equal(calls.length,0);
  assert.equal(await unpublishInactiveProduct(c,'company-a',{id:'latte',active:false}),true);
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.sql.includes('published=false')));
  assert.deepEqual(calls.map(call=>call.params),[['company-a','latte'],['company-a','latte']]);
});
