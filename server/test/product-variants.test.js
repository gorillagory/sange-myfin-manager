import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileProductVariants } from '../src/business.js';

test('product edits upsert stable variants before deleting only removed variants', async () => {
  const calls=[];
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[]};}};
  const product={id:'latte',variants:[
    {id:'hot',stock:4,price:8,cost:3},
    {id:'iced',stock:6,price:9,cost:3.5},
  ]};

  await reconcileProductVariants(client,'company-a',product);

  assert.equal(calls.length,3);
  for(const call of calls.slice(0,2)){
    assert.match(call.sql,/INSERT INTO myfin\.product_variants/);
    assert.match(call.sql,/ON CONFLICT\(company_id,product_id,id\) DO UPDATE/);
    assert.match(call.sql,/SET stock=EXCLUDED\.stock,price=EXCLUDED\.price,cost=EXCLUDED\.cost/);
  }
  assert.deepEqual(calls[0].params,['company-a','latte','hot',4,8,3]);
  assert.deepEqual(calls[1].params,['company-a','latte','iced',6,9,3.5]);
  assert.match(calls[2].sql,/NOT \(id=ANY\(\$3::text\[\]\)\)/);
  assert.deepEqual(calls[2].params,['company-a','latte',['hot','iced']]);
});

test('removing every variant still uses the scoped cleanup query', async () => {
  const calls=[];
  await reconcileProductVariants({query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[]};}},
    'company-a',{id:'tea',variants:[]});
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/company_id=\$1 AND product_id=\$2/);
  assert.deepEqual(calls[0].params,['company-a','tea',[]]);
});
