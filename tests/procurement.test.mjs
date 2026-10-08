import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseQuantity, lineTotalSen, normalizeStockIdentifier, prepareReceiptLines,
  purchaseOrderStatus, reverseWeightedAverageCost, weightedAverageCost,
} from '../src/domain/procurement.js';

test('stock identifiers keep manufacturer codes distinct from internal SKU labels',()=>{
  assert.deepEqual(normalizeStockIdentifier('gtin','9501 1015-30003'),{
    raw:'9501 1015-30003',normalized:'9501101530003',
  });
  assert.deepEqual(normalizeStockIdentifier('internal_sku',' milk-1 '),{
    raw:'milk-1',normalized:'MILK-1',
  });
  assert.deepEqual(normalizeStockIdentifier('manufacturer_barcode','case-aB'),{
    raw:'case-aB',normalized:'CASE-AB',
  });
  assert.throws(()=>normalizeStockIdentifier('gtin','9501101530004'),/check digit/);
  assert.throws(()=>normalizeStockIdentifier('upc','123'),/length/);
});

test('purchase totals use quantity micros and half-up whole-sen rounding',()=>{
  assert.equal(lineTotalSen(2.5,199),498n);
  assert.equal(lineTotalSen(0.333333,300),100n);
  assert.equal(baseQuantity(2.5,1000),2500);
  assert.throws(()=>lineTotalSen(1.0000009,100),/six decimal/);
  assert.throws(()=>lineTotalSen(1,1.5),/integer/);
});

test('partial receipts reject duplicates and over-receipt before stock is touched',()=>{
  const lines=[
    {id:'cups',stockItemId:'cup',orderedPurchaseQuantity:10,quantityInBase:50,unitPriceSen:1200,purchaseUnit:'carton'},
    {id:'milk',stockItemId:'milk',orderedPurchaseQuantity:4,quantityInBase:1000,unitPriceSen:850,purchaseUnit:'carton'},
  ];
  const received=new Map([['cups',2]]);
  const result=prepareReceiptLines(lines,received,[
    {purchaseOrderLineId:'cups',quantity:3,batchCode:'C-1',lotCode:'',expiryDate:''},
    {purchaseOrderLineId:'milk',quantity:1.5,batchCode:'',lotCode:'M-1',expiryDate:'2027-01-01'},
  ]);
  assert.deepEqual(result.map(row=>[row.stockItemId,row.baseQuantity,row.costSen]),[
    ['cup',150,3600n],['milk',1500,1275n],
  ]);
  assert.equal(purchaseOrderStatus(lines,new Map([['cups',5],['milk',1.5]])),'partially_received');
  assert.equal(purchaseOrderStatus(lines,new Map([['cups',10],['milk',4]])),'received');
  assert.throws(()=>prepareReceiptLines(lines,received,[
    {purchaseOrderLineId:'cups',quantity:9},{purchaseOrderLineId:'cups',quantity:1},
  ]),/exceeds|once/);
});

test('weighted-average receipt and compensating reversal preserve integer-sen value',()=>{
  const after=weightedAverageCost({quantity:10,valueSen:1000n},{quantity:5,valueSen:750n});
  assert.deepEqual(after,{quantity:15,valueSen:1750n,averageCostSen:1750/15});
  const reversed=reverseWeightedAverageCost(after,{quantity:5,valueSen:750n});
  assert.deepEqual(reversed,{quantity:10,valueSen:1000n,averageCostSen:100});
  assert.throws(()=>reverseWeightedAverageCost(after,{quantity:16,valueSen:1n}),/exceeds/);
  assert.throws(()=>reverseWeightedAverageCost(after,{quantity:1,valueSen:2000n}),/exceeds/);
});

