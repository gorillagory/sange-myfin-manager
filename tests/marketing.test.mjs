import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';
import {
  ATTRIBUTION_NOTICE, CAMPAIGN_GOALS, MARKETING_CHANNELS, attributedMetricCards,
  audiencePayload, campaignPayload, campaignPublishError, campaignStepError, campaignToForm, emptyCampaign, loadMarketingWorkspace, normalizeMarketingWorkspace,
  legacyPromotionPayload, saveMarketingCampaign,
} from '../src/domain/marketing.js';
import { permissionsFor } from '../src/domain/permissions.js';
import { canVisit, ROUTE_CAPABILITIES } from '../src/domain/viewAccess.js';

test('sales and marketing permissions are company-managed with owner-only workspace controls', () => {
  for (const role of ['super','super_admin','workspace_owner']) {
    const permission=permissionsFor({role});
    assert.equal(permission.marketingRead,true);
    assert.equal(permission.marketingManage,true);
    assert.equal(permission.marketingWorkspaceManage,true);
    assert.equal(permission.loyaltyWorkspaceManage,true);
  }
  for (const role of ['manager','company_admin']) {
    const permission=permissionsFor({role});
    assert.equal(permission.marketingRead,true);
    assert.equal(permission.marketingManage,true);
    assert.equal(permission.promotionsManage,true);
    assert.equal(permission.marketingWorkspaceManage,false);
    assert.equal(canVisit({role},'/marketing'),true);
  }
  for (const role of ['operator','company_user']) {
    assert.equal(permissionsFor({role}).marketingRead,false);
    assert.equal(canVisit({role},'/marketing'),false);
  }
  assert.equal(ROUTE_CAPABILITIES['/marketing'],'marketingRead');
});

test('campaign vocabulary and payload use exact API identifiers and no fake all-customer audience', () => {
  assert.deepEqual(CAMPAIGN_GOALS.map(row=>row.id),[
    'acquisition','repeat_purchase','loyalty','basket_growth','inventory_clearance',
  ]);
  assert.deepEqual(MARKETING_CHANNELS.map(row=>row.id),['storefront','pos','email']);
  const form={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'Bring lunch customers back',
    audienceId:'audience-1',audienceVersion:4,offerType:'bonus_points',offerValue:'75',
    channels:['storefront','email'],startsAt:'2026-10-11T10:00:00+08:00',endsAt:'2026-10-31T22:00:00+08:00',
    minimumSpend:'15.00',budget:'500.00',maxRedemptions:'',perCustomerLimit:''};
  const payload=campaignPayload(form);
  assert.equal(payload.objective,'acquisition');
  assert.deepEqual(payload.channels,['storefront','email']);
  assert.deepEqual(payload.audienceLinks,[{audienceId:'audience-1',audienceVersion:4}]);
  assert.equal(payload.offerKind,'bonus_points');
  assert.equal(payload.bonusPoints,75);
  assert.equal(payload.bonusMinimumSpendSen,1500);
  assert.equal(payload.budgetSen,50000);
  assert.deepEqual(campaignPayload({...form,audienceId:'',audienceVersion:null}).audienceLinks,[]);
  assert.equal(emptyCampaign().audienceId,'');
});

test('workspace load enriches immutable campaign offers with editable legacy limits', async () => {
  const request=async path=>{
    if(path.endsWith('/marketing')) return {campaigns:[],audiences:[],availablePromotions:[{
      promotionId:'offer-1',promotionVersion:3,name:'Return visit',discountType:'percentage',discountBasisPoints:1200,enabled:false,
    }]};
    if(path.includes('/customer-profiles')) return {rows:[]};
    if(path.endsWith('/marketing/loyalty')) return {settings:{version:1}};
    if(path.includes('/student-programs')) return {students:[],promotions:[{
      id:'offer-1',version:3,name:'Return visit',minSubtotalSen:1500,maxDiscountSen:800,
      maxTotalRedemptions:90,perCustomerLimit:2,
    }]};
    throw Object.assign(new Error('unexpected'),{status:500});
  };
  const workspace=await loadMarketingWorkspace(request,'company-1');
  assert.equal(workspace.offers[0].minSubtotalSen,1500);
  assert.equal(workspace.offers[0].maxTotalRedemptions,90);
  assert.equal(workspace.offers[0].discountBasisPoints,1200);
});

test('campaign edit form restores the exact linked offer and its schedule controls', () => {
  const form=campaignToForm({id:'campaign-1',version:6,name:'Return visit',objective:'repeat_purchase',
    channels:['pos'],startsAt:'2026-10-11T02:00:00.000Z',endsAt:'2026-10-31T14:00:00.000Z',budgetSen:50000,
    offerKind:'promotion',promotionLinks:[{promotionId:'offer-1',promotionVersion:3}],audienceLinks:[]},[{
      id:'offer-1',version:3,discountType:'free_item',rewardProductId:'product-1',rewardVariantId:'variant-1',
      redemptionMode:'voucher',minSubtotalSen:1200,maxDiscountSen:null,maxTotalRedemptions:100,perCustomerLimit:1,
      stackable:true,priority:75,
      productTargets:[{productId:'product-2',variantId:''}],categoryTargets:[{category:'menu',subcategory:'beverages'}],
    }]);
  assert.equal(form.existingPromotionKey,'offer-1:3');
  assert.equal(form.offerType,'free_item');
  assert.equal(form.rewardProductId,'product-1');
  assert.equal(form.rewardVariantId,'variant-1');
  assert.equal(form.redemptionMode,'voucher');
  assert.equal(form.minimumSpend,'12.00');
  assert.equal(form.maxRedemptions,'100');
  assert.equal(form.perCustomerLimit,'1');
  assert.equal(form.stackable,true);
  assert.equal(form.priority,'75');
  assert.deepEqual(form.targetProductKeys,[JSON.stringify(['product-2',''])]);
  assert.deepEqual(form.targetCategoryKeys,[JSON.stringify(['menu','beverages'])]);
});

test('campaign offer payload accepts picker-backed targets and voucher mode', () => {
  const payload=legacyPromotionPayload({...emptyCampaign(new Date('2026-10-10T00:00:00Z')),
    name:'Pastry return',offerType:'fixed',offerValue:'5.00',redemptionMode:'voucher',
    stackable:true,priority:'90',
    startsAt:'2026-10-11T10:00:00+08:00',targetProductKeys:[JSON.stringify(['product-1','variant-2'])],
    targetCategoryKeys:[JSON.stringify(['menu','pastry'])]});
  assert.equal(payload.enabled,false);
  assert.equal(payload.redemptionMode,'voucher');
  assert.equal(payload.stackable,true);
  assert.equal(payload.priority,90);
  assert.deepEqual(payload.productTargets,[{productId:'product-1',variantId:'variant-2'}]);
  assert.deepEqual(payload.categoryTargets,[{category:'menu',subcategory:'pastry'}]);
});

test('free-item campaign validation requires an exact option for a product with variants', () => {
  const input={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'Free latte',
    offerType:'free_item',rewardProductId:'latte',rewardVariantId:''};
  const products=[{id:'latte',name:'Latte',variants:[{id:'large',name:'Large'}]}];
  assert.equal(campaignStepError(2,input,{products}),
    'Choose the exact product option for the free item.');
  assert.equal(campaignStepError(2,{...input,rewardVariantId:'large'},{products}),'');
  assert.equal(campaignStepError(2,{...input,rewardProductId:'cookie'},{products:[{
    id:'cookie',name:'Cookie',variants:[],
  }]}),'');
});

test('voucher campaigns cannot publish until an enabled unexhausted code covers the schedule', async () => {
  const base={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'Voucher launch',
    offerMode:'new',offerType:'percentage',redemptionMode:'voucher',startsAt:'2026-10-11T10:00:00+08:00',
    endsAt:'2026-10-31T22:00:00+08:00',availableOffers:[]};
  assert.match(campaignPublishError(base,[]),/Save this voucher campaign as a draft/);
  const calls=[];
  await assert.rejects(saveMarketingCampaign(async(...args)=>{calls.push(args);},'company-1',base,{publish:true}),
    /Save this voucher campaign as a draft/);
  assert.equal(calls.length,0,'publish preflight must not leave an orphan offer or campaign');
  const offer={id:'offer-v',version:2,redemptionMode:'voucher',vouchers:[{
    enabled:true,validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-11-01T00:00:00Z',
    maxRedemptions:100,redeemedCount:99,
  }]};
  const existing={...base,offerMode:'existing',offerChanged:false,existingPromotionKey:'offer-v:2'};
  assert.equal(campaignPublishError(existing,[offer]),'');
  assert.match(campaignPublishError(existing,[{...offer,vouchers:[{...offer.vouchers[0],redeemedCount:100}]}]),
    /Create and enable a voucher code/);
});

test('bonus-point campaigns do not imply unsupported award caps', () => {
  const input={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'Bonus visit',
    offerType:'bonus_points',offerValue:'25',maxRedemptions:'100',perCustomerLimit:'1'};
  assert.equal(campaignStepError(4,input),
    'Bonus-point award caps are not available in this release.');
  assert.throws(()=>campaignPayload(input),/award caps are not available/);
  assert.throws(()=>campaignPayload({...input,maxRedemptions:'',perCustomerLimit:'',channels:['email']},{publish:true,
  }),/Add POS or Online storefront/, 'publish requires a live pricing channel');
});

test('audience payload sends complete strict criteria and preserves workspace scope', () => {
  assert.deepEqual(audiencePayload({name:'Regulars',description:'Repeat customers',accountRequired:true,
    minOrderCount:'3',minSpend:'50.00',minLoyaltyPoints:'20',lastPurchaseWithinDays:'45',
    consentRequired:true,consentChannels:['email'],studentStatus:'any',includeCustomerIds:['c-1'],excludeCustomerIds:[]},
  {workspace:true}),{
    expectedVersion:0,name:'Regulars',description:'Repeat customers',scope:'workspace',
    consent:{required:true,channels:['email']},eligibility:{studentStatus:'any'},
    customer:{accountRequired:true,minOrderCount:3,minSpendSen:5000,minLoyaltyPoints:20,
      lastPurchaseWithinDays:45,includeCustomerIds:['c-1'],excludeCustomerIds:[]},
  });
  const broad=audiencePayload({name:'Everyone'});
  assert.deepEqual(audiencePayload({name:'Everyone',consentRequired:false,
    consentChannels:['email','invalid-stale-value']}).consent,{required:false,channels:[]});
  assert.throws(()=>audiencePayload({name:'Members',consentRequired:true,consentChannels:[]}),
    /at least one consent channel/);
  assert.equal(broad.customer.minOrderCount,0);
  assert.equal(broad.customer.minSpendSen,0);
  assert.equal(broad.customer.minLoyaltyPoints,0);
  assert.equal(broad.customer.lastPurchaseWithinDays,null);
});

test('published campaign creates a disabled offer first then lets the campaign transition activate it', async () => {
  const calls=[];
  const request=async(path,options={})=>{
    calls.push({path,options});
    if(path.endsWith('/student-promotions'))return{id:'offer-1',version:1};
    if(path.endsWith('/marketing/campaigns'))return{id:'campaign-1',version:1};
    if(path.endsWith('/campaign-1/publish'))return{id:'campaign-1',version:2,lifecycle:'published'};
    throw Object.assign(new Error('unexpected'),{status:500});
  };
  const form={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'Weekend welcome',
    offerType:'percentage',offerValue:'10',channels:['storefront'],
    startsAt:'2026-10-11T10:00:00+08:00',endsAt:'',availableOffers:[],availableAudiences:[]};
  const result=await saveMarketingCampaign(request,'company-1',form,{publish:true});
  assert.equal(result.version,2);
  assert.deepEqual(calls.map(call=>call.path),[
    '/companies/company-1/student-promotions',
    '/companies/company-1/marketing/campaigns',
    '/companies/company-1/marketing/campaigns/campaign-1/publish',
  ]);
  assert.equal(calls[0].options.body.enabled,false);
  assert.deepEqual(calls[1].options.body.promotionLinks,[{promotionId:'offer-1',promotionVersion:1}]);
  assert.deepEqual(calls[2].options.body,{expectedVersion:1});
});

test('POS-only campaign is valid and persists its linked offer before publishing', async () => {
  const calls=[];
  const request=async(path,options={})=>{calls.push({path,options});if(path.endsWith('/student-promotions'))return{id:'offer-pos',version:1};if(path.endsWith('/marketing/campaigns'))return{id:'campaign-pos',version:1};return{id:'campaign-pos',version:2,lifecycle:'published'};};
  const form={...emptyCampaign(new Date('2026-10-10T00:00:00Z')),name:'POS launch',
    offerType:'percentage',offerValue:'10',channels:['pos'],
    startsAt:'2026-10-11T10:00:00+08:00',endsAt:'',availableOffers:[],availableAudiences:[]};
  const saved=await saveMarketingCampaign(request,'company-1',form,{publish:true});
  assert.equal(saved.lifecycle,'published');
  assert.deepEqual(calls.map(call=>call.path),[
    '/companies/company-1/student-promotions',
    '/companies/company-1/marketing/campaigns',
    '/companies/company-1/marketing/campaigns/campaign-pos/publish',
  ]);
  assert.deepEqual(calls[1].options.body.channels,['pos']);
});

test('bonus-point campaign is native and does not create a monetary promotion', async () => {
  const calls=[];
  const request=async(path,options={})=>{calls.push({path,options});return{id:'campaign-2',version:1};};
  await saveMarketingCampaign(request,'company-1',{...emptyCampaign(new Date('2026-10-10T00:00:00Z')),
    name:'Member bonus',offerType:'bonus_points',offerValue:'25',minimumSpend:'5.00',
    startsAt:'2026-10-11T10:00:00+08:00',availableAudiences:[],maxRedemptions:'',perCustomerLimit:''});
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.body.offerKind,'bonus_points');
  assert.equal(calls[0].options.body.bonusPoints,25);
  assert.equal(calls[0].options.body.bonusMinimumSpendSen,500);
});

test('attributed cards suppress small customer cohorts and make causality limits explicit', () => {
  const cards=attributedMetricCards({qualifiedQuotes:9,conversions:2,attributedRevenueSen:1200,
    discountCostSen:100,averageOrderValueSen:600,voucherUses:1},'RM',{suppressed:true,cohortThreshold:5});
  assert.equal(cards.find(card=>card.key==='uniqueCustomers').value,'Hidden (<5)');
  assert.match(ATTRIBUTION_NOTICE,/do not prove.*caused|not prove.*caused/i);
  const normalized=normalizeMarketingWorkspace({campaigns:[],summary:{campaignCount:0}});
  assert.equal(normalized.analytics.attributedRevenueSen,null);
});

test('marketing hub and all panels compile and expose the renamed navigation', async () => {
  const files=['MarketingHub.vue','marketing/CampaignWizard.vue','marketing/MarketingOverview.vue',
    'marketing/MarketingCampaigns.vue','marketing/MarketingOffers.vue','marketing/MarketingLoyalty.vue',
    'marketing/MarketingAudiences.vue','marketing/MarketingEligibility.vue'];
  for(const file of files){
    const url=new URL(`../src/components/dashboard/${file}`,import.meta.url),source=await readFile(url,'utf8');
    const parsed=parse(source,{filename:url.pathname});assert.deepEqual(parsed.errors,[],file);
    const script=compileScript(parsed.descriptor,{id:`marketing-${file}`});
    const template=compileTemplate({source:parsed.descriptor.template.content,filename:url.pathname,
      id:`marketing-${file}`,compilerOptions:{bindingMetadata:script.bindings}});
    assert.deepEqual(template.errors,[],file);
    for(const style of parsed.descriptor.styles){const result=compileStyle({source:style.content,filename:url.pathname,
      id:`marketing-${file}`,scoped:style.scoped});assert.deepEqual(result.errors,[],file);}
  }
  const [shell,router,modules]=await Promise.all([
    readFile(new URL('../src/components/EditionShell.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/router/index.js',import.meta.url),'utf8'),
    readFile(new URL('../src/domain/workspaceModules.js',import.meta.url),'utf8'),
  ]);
  assert.match(shell,/WORKSPACE_MODULES/);
  assert.match(modules,/label: 'Analytics'/);
  assert.match(modules,/path: '\/marketing', title: 'Marketing'/);
  assert.doesNotMatch(modules,/path: '\/student-programs'/);
  assert.match(router,/path: '\/marketing'/);
  assert.match(router,/path: '\/student-programs'.*path:'\/marketing'.*tab:'eligibility'/s);
  const wizard=await readFile(new URL('../src/components/dashboard/marketing/CampaignWizard.vue',import.meta.url),'utf8');
  const campaigns=await readFile(new URL('../src/components/dashboard/marketing/MarketingCampaigns.vue',import.meta.url),'utf8');
  assert.doesNotMatch(`${wizard}\n${campaigns}`,/cannot be published|draft-only|enforcement is available/i);
  assert.match(wizard,/v-if="canPublish"/);
  assert.match(wizard,/Higher priority offers are evaluated first/);
  assert.match(wizard,/Eligible POS baskets receive this reward automatically/);
  assert.match(wizard,/online storefront, the shopper must add the reward product/);
  assert.equal(wizard.match(/products:props\.products/g)?.length,2,
    'both step and submit validation must receive the product variants');
});

test('marketing loyalty history rejects stale company responses and reloads on company switches', async () => {
  const source=await readFile(new URL('../src/components/dashboard/MarketingHub.vue',import.meta.url),'utf8');
  assert.match(source,/let requestVersion=0,loyaltyRequestVersion=0/);
  assert.match(source,/const companyId=company\.value\.id,current=\+\+loyaltyRequestVersion/);
  assert.match(source,/marketingPaths\(companyId\)\.loyalty/);
  assert.match(source,/events\?scope=company&limit=100/);
  assert.match(source,/current===loyaltyRequestVersion&&company\.value\.id===companyId\)loyaltyEvents\.value=/);
  assert.match(source,/watch\(\(\)=>company\.value\.id,\(\)=>\{loyaltyRequestVersion\+\+/);
  assert.match(source,/watch\(\[tab,\(\)=>company\.value\.id\],\(\[value,companyId\]\)=>\{if\(value==='loyalty'&&companyId\)loadLoyaltyEvents\(\)/);
});
