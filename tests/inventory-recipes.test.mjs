import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateRecipeConsumption,normalizeRecipeDraft,recipeAvailability,recipeTargetKey} from '../src/domain/inventoryRecipes.js';

test('recipe drafts are opt-in, versioned and reject duplicate stock items',()=>{
  assert.deepEqual(normalizeRecipeDraft({productId:'latte',components:[{stockItemId:'beans',quantityPerUnit:18}]}),{
    productId:'latte',variantId:'',version:0,enabled:false,components:[{stockItemId:'beans',quantityPerUnit:18}],
  });
  assert.throws(()=>normalizeRecipeDraft({productId:'latte',enabled:true,components:[]}),/at least one/);
  assert.throws(()=>normalizeRecipeDraft({productId:'latte',components:[
    {stockItemId:'milk',quantityPerUnit:200},{stockItemId:'milk',quantityPerUnit:100},
  ]}),/each stock item once/);
  assert.equal(recipeTargetKey('latte','iced'),'latte\u0000iced');
});

test('component consumption aggregates lines and exact variants override product fallback',()=>{
  const recipes=[
    {id:'base',productId:'latte',variantId:'',version:2,enabled:true,components:[
      {stockItemId:'beans',quantityPerUnit:18},{stockItemId:'milk',quantityPerUnit:180},
    ]},
    {id:'iced',productId:'latte',variantId:'iced',version:4,enabled:true,components:[
      {stockItemId:'beans',quantityPerUnit:20},{stockItemId:'milk',quantityPerUnit:150},{stockItemId:'ice',quantityPerUnit:6},
    ]},
    {id:'disabled',productId:'tea',variantId:'',version:1,enabled:false,components:[{stockItemId:'water',quantityPerUnit:250}]},
  ];
  const result=aggregateRecipeConsumption([
    {productId:'latte',qty:2},{productId:'latte',variantId:'iced',qty:1},
    {productId:'latte',variantId:'hot',qty:1},{productId:'tea',qty:1},
  ],recipes);
  assert.equal(result.matchedLines,3);
  assert.deepEqual(result.consumptions.map(row=>[row.stockItemId,row.quantity]),[
    ['beans',74],['ice',6],['milk',690],
  ]);
  assert.equal(result.consumptions.find(row=>row.stockItemId==='beans').contributions[1].recipeId,'iced');
  assert.throws(()=>aggregateRecipeConsumption([{productId:'latte',qty:0}],recipes),/greater than zero/);
});

test('recipe availability reports the limiting active stock item',()=>{
  const components=[{stockItemId:'beans',quantityPerUnit:18},{stockItemId:'milk',quantityPerUnit:180}];
  assert.deepEqual(recipeAvailability(components,[
    {id:'beans',onHand:180,active:true},{id:'milk',onHand:900,active:true},
  ]),{units:5,limitingStockItemId:'milk',complete:true});
  assert.deepEqual(recipeAvailability(components,[{id:'beans',onHand:180,active:true}]),{
    units:0,limitingStockItemId:'milk',complete:false,
  });
});
