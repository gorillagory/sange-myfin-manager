import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerStorefrontPublic } from '../src/storefront-public.js';

test('storefront commerce migration bounds public creative fields and stores online prices in exact sen', async () => {
  const sql=await readFile(new URL('../../db/migrations/0035_storefront_commerce.sql',import.meta.url),'utf8');
  assert.match(sql,/theme_primary_color[\s\S]*\^#\[0-9a-fA-F\]\{6\}\$/);
  assert.match(sql,/carousel_interval_seconds BETWEEN 3 AND 30/);
  assert.match(sql,/CREATE TABLE myfin\.storefront_carousel_slides/);
  assert.match(sql,/CHECK\(length\(btrim\(title\)\) BETWEEN 1 AND 160\)/);
  assert.match(sql,/online_price_sen integer[\s\S]*BETWEEN 0 AND 100000000/);
  assert.match(sql,/REVOKE ALL ON myfin\.storefront_carousel_slides FROM PUBLIC/);
});

test('catalog alignment migration separates channel presentation from immutable price evidence', async () => {
  const sql=await readFile(new URL('../../db/migrations/0052_catalog_channel_alignment.sql',import.meta.url),'utf8');
  assert.match(sql,/ADD COLUMN image_url text NOT NULL DEFAULT ''/);
  assert.match(sql,/ADD COLUMN catalog_unit_price_sen bigint/);
  assert.match(sql,/ADD COLUMN catalog_product_version bigint/);
  assert.match(sql,/price_source IN \('catalog','online_override'\)/);
  assert.match(sql,/catalog_unit_price_sen IS NULL AND catalog_product_version IS NULL AND price_source IS NULL/);
  assert.match(sql,/catalog_unit_price_sen IS NOT NULL[\s\S]*catalog_product_version IS NOT NULL[\s\S]*price_source IS NOT NULL/);
  assert.doesNotMatch(sql,/UPDATE myfin\.pricing_snapshot_lines/,
    'pre-migration immutable pricing history is identified as unknown instead of rewritten');
});

test('public storefront exposes bounded creative content and matching effective online prices', async () => {
  const routes=new Map();
  let productSql='';
  const register=method=>(path,options,handler)=>routes.set(`${method} ${path}`,handler||options);
  const app={get:register('GET'),post:register('POST')};
  const settings={company_id:'company-a',workspace_id:'workspace-a',published:true,display_name:'Bali Coffee',
    description:'Coffee for collection',pickup_instructions:'Collect at counter',delivery_enabled:false,
    max_item_quantity:'20',company_name:'Bali Coffee',company_data:{preferences:{currency:'RM',taxRate:6}},
    privacy_controller_name:'Example Foods',privacy_controller_contact:'privacy@example.test',
    privacy_notice_url:'https://example.test/privacy',privacy_notice_en:'English notice',privacy_notice_ms:'Notis BM',
    guest_data_retention_days:90,logo_url:'https://example.test/logo.png',theme_primary_color:'#123456',
    theme_accent_color:'#fedcba',theme_background_color:'#ffffff',theme_text_color:'#111111',
    theme_font_family:'geist',hero_eyebrow:'ORDER ONLINE',hero_title:'Ready when you are',
    hero_description:'Skip the queue',hero_image_url:'http://unsafe.test/hero.jpg',carousel_interval_seconds:6};
  const c={query:async sql=>{
    if(sql.includes('SELECT s.*,c.name AS company_name'))return {rows:[settings]};
    if(sql.includes('FROM myfin.shop_locations'))return {rows:[]};
    if(sql.includes('FROM myfin.storefront_carousel_slides'))return {rows:[{id:'slide-a',badge:'FEATURED',
      title:'Weekend coffee',description:'Two cups, one easy order',image_url:'https://example.test/offer.jpg',
      background_color:'#234567',cta_label:'View menu',cta_url:'/shop'}]};
    if(sql.includes('FROM myfin.products p LEFT JOIN myfin.storefront_products')){productSql=sql;return {rows:[{id:'latte',
      data:{name:'Latte',category:'Coffee',variants:[{id:'large',name:'Large',stock:10}]},price:'10.0000',
      stock:'10',sort_order:0,sold_out:false,online_price_sen:900,storefront_image_url:''}]};}
    if(sql.includes('FROM myfin.product_variants pv LEFT JOIN myfin.storefront_product_variants'))return {rows:[{product_id:'latte',
      variant_id:'large',sold_out:false,sort_order:0,online_price_sen:null,store_price:'12.0000'}]};
    return {rows:[],rowCount:0};
  }};
  registerStorefrontPublic(app,{db:{transaction:fn=>fn(c)},authOptions:{publicProxyAddresses:[]}});
  const result=await routes.get('GET /api/public/storefront')({tenant:{surface:'storefront',company_id:'company-a',
    workspace_id:'workspace-a'},query:{},headers:{},socket:{remoteAddress:'127.0.0.1'}});
  assert.deepEqual(result.storefront.theme,{primaryColor:'#123456',accentColor:'#fedcba',
    backgroundColor:'#ffffff',textColor:'#111111',fontFamily:'geist'});
  assert.equal(result.storefront.hero.imageUrl,'');
  assert.deepEqual(result.slides,[{id:'slide-a',badge:'FEATURED',title:'Weekend coffee',
    description:'Two cups, one easy order',imageUrl:'https://example.test/offer.jpg',backgroundColor:'#234567',
    ctaLabel:'View menu',ctaUrl:'/shop'}]);
  assert.equal(result.products[0].storePrice,10);
  assert.equal(result.products[0].onlinePrice,9);
  assert.equal(result.products[0].price,9);
  assert.equal(result.products[0].active,true);
  assert.equal(result.products[0].hasOnlinePriceOverride,true);
  assert.equal(result.products[0].name,'Latte');
  assert.equal(result.products[0].variants[0].storePrice,12);
  assert.equal(result.products[0].variants[0].onlinePrice,9);
  assert.match(productSql,/coalesce\(p\.data->>'active','true'\)<>'false'/);
  assert.match(productSql,/LEFT JOIN myfin\.storefront_products/);
  assert.doesNotMatch(productSql,/sp\.published/);
});
