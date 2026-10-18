<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { Store } from '../../store';
import { api } from '../../services/api';
import { money } from '../../domain/pos';
import { storefrontContrastIssues, storefrontFontStack } from '../../domain/customerOrdering';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const props = defineProps({ company: { type:Object, required:true } });
const loading=ref(false),busy=ref(false),error=ref(''),saved=ref('');
const storefront=ref(defaultSettings()),locations=ref([]),deliveryZones=ref([]),slides=ref([]),publication=ref(new Map());
const hostSaved=ref(false),savedHostname=ref('');
const locationEditor=ref(null),deliveryEditor=ref(null),qr=ref(null),qrImage=ref(''),productBusy=ref('');
const editorPanel=ref('basics'),previewDevice=ref('mobile'),menuSearch=ref(''),menuFilter=ref('all');
const editorPanels=[
  {id:'basics',label:'Start here',hint:'Name, ordering and collection'},
  {id:'appearance',label:'Brand',hint:'Colors, logo and welcome'},
  {id:'promotions',label:'Promotions',hint:'Offers shown to customers'},
  {id:'menu',label:'Menu & prices',hint:'Choose items and online prices'},
  {id:'advanced',label:'Safety & limits',hint:'Privacy, order limits and web address'},
];
const themePresets=[
  {name:'Fresh',primary:'#17624d',accent:'#d7a43b',background:'#fbfcf8',text:'#15382c'},
  {name:'Warm',primary:'#8a3f2d',accent:'#e7a84b',background:'#fffaf3',text:'#34231f'},
  {name:'Midnight',primary:'#1d3557',accent:'#e9b949',background:'#f7f9fc',text:'#17243a'},
  {name:'Plum',primary:'#6d2d62',accent:'#e4a853',background:'#fff9fd',text:'#352230'},
];
const base=()=>`/companies/${encodeURIComponent(props.company.id)}/storefront`;
const currency=computed(()=>props.company.preferences?.currency||'RM');
const hostReady=computed(()=>hostSaved.value&&storefront.value.hostname.trim().toLowerCase()===savedHostname.value);
const shopUrl=computed(()=>hostReady.value?`https://${savedHostname.value}/shop`:'');
const displayUrl=computed(()=>hostReady.value?`https://${savedHostname.value}/display`:'');
const previewSlide=computed(()=>slides.value.find(row=>row.published)||slides.value[0]||null);
const contrastIssues=computed(()=>storefrontContrastIssues({
  primaryColor:storefront.value.themePrimaryColor,
  backgroundColor:storefront.value.themeBackgroundColor,
  textColor:storefront.value.themeTextColor,
},slides.value));
const previewStyle=computed(()=>({background:storefront.value.themeBackgroundColor,color:storefront.value.themeTextColor,
  '--preview-primary':storefront.value.themePrimaryColor,'--preview-accent':storefront.value.themeAccentColor,
  fontFamily:storefrontFontStack(storefront.value.themeFontFamily)}));
const products=computed(()=>Store.state.products.map(product=>{
  const current=publication.value.get(product.id)||{};
  const publishedVariants=new Map((current.variants||[]).map(row=>[row.variantId,row]));
  return {product,...current,productId:product.id,productName:current.productName||product.name,published:!!current.published,soldOut:!!current.soldOut,sortOrder:Number(current.sortOrder||0),displayName:current.displayName||'',description:current.description||'',onlinePrice:current.onlinePriceSen==null?'':Number(current.onlinePriceSen)/100,variantIds:current.variantIds||current.variants?.filter(x=>x.published).map(x=>x.variantId)||product.variants.map(x=>x.id),variantPrices:product.variants.map(variant=>{const saved=publishedVariants.get(variant.id);return {variantId:variant.id,name:variant.name,storePrice:Number(saved?.storePriceSen??Math.round(Number(variant.price)*100))/100,onlinePrice:saved?.onlinePriceSen==null?'':Number(saved.onlinePriceSen)/100};})};
}));
const filteredProducts=computed(()=>products.value.filter(row=>{
  if(menuFilter.value==='live'&&(!row.published||row.soldOut))return false;
  if(menuFilter.value==='hidden'&&row.published)return false;
  const needle=menuSearch.value.trim().toLowerCase();
  return !needle||[row.productName,row.displayName,row.product.category,row.product.subcategory].some(value=>String(value||'').toLowerCase().includes(needle));
}));
const setupSteps=computed(()=>[
  {label:'Shop details',panel:'basics',ready:!!(storefront.value.displayName.trim()||props.company.name)},
  {label:'Web address',panel:'basics',ready:hostReady.value},
  {label:'Collection point',panel:'basics',ready:locations.value.some(row=>row.active&&['pickup','both'].includes(row.fulfillmentMode))},
  {label:'Menu items',panel:'menu',ready:products.value.some(row=>row.published&&!row.soldOut)},
  {label:'Customer privacy',panel:'advanced',ready:!!(storefront.value.privacyControllerName.trim()&&storefront.value.privacyControllerContact.trim()&&storefront.value.privacyNoticeUrl.trim()&&storefront.value.privacyNoticeEn.trim()&&storefront.value.privacyNoticeMs.trim())},
]);
const readySteps=computed(()=>setupSteps.value.filter(step=>step.ready).length);
function defaultSettings(){return {published:false,deliveryEnabled:false,hostname:'',displayName:'',description:'',pickupInstructions:'',orderExpiryMinutes:30,maxOrderItems:30,maxItemQuantity:20,maxOrderValue:1000,guestContactRetentionDays:90,privacyControllerName:'',privacyControllerContact:'',privacyNoticeUrl:'',privacyNoticeEn:'',privacyNoticeMs:'',logoUrl:'',themePrimaryColor:'#17624d',themeAccentColor:'#d7a43b',themeBackgroundColor:'#fbfcf8',themeTextColor:'#15382c',themeFontFamily:'geist',heroEyebrow:'ORDER ONLINE',heroTitle:'',heroDescription:'',heroImageUrl:'',carouselIntervalSeconds:7};}
function suggestedHost(){return props.company.hostname?`order-${props.company.hostname}`:'';}
function hydrate(result){
  hostSaved.value=!!result.storefront?.hostname;savedHostname.value=result.storefront?.hostname||'';
  storefront.value={...defaultSettings(),...(result.storefront||{})};
  if(!storefront.value.hostname)storefront.value.hostname=suggestedHost();
  locations.value=result.locations||[];
  slides.value=(result.slides||[]).map(row=>({...row}));
  deliveryZones.value=(result.deliveryZones||[]).map(row=>({...row,fee:Number(row.feeSen||0)/100,minimumOrder:Number(row.minimumOrderSen||0)/100}));
  publication.value=new Map((result.products||[]).map(row=>[row.productId,{...row,variantIds:(row.variants||[]).filter(x=>x.published&&!x.soldOut).map(x=>x.variantId)}]));
}
async function load(){loading.value=true;error.value='';try{hydrate(await api(base()));}catch(caught){error.value=message(caught);}finally{loading.value=false;}}
function message(caught){return ({storefront_host_and_location_required:'Save the public hostname before publishing.',storefront_pickup_location_required:'Keep at least one active pickup or pickup-and-table location for the general shop QR.',storefront_privacy_notice_required:'Add the privacy controller, contact, HTTPS privacy notice URL and both English and Bahasa Melayu short notices before publishing.',delivery_zone_required:'Keep at least one delivery zone enabled, or turn delivery off first.',delivery_zone_not_found:'That delivery zone no longer exists.',hostname_unavailable:'That public order address belongs to another company.',storefront_hostname_change_blocked_by_online_payment:'Finish or reconcile every online payment before changing the public order address.',invalid_storefront_hostname:'Use an order-… hostname already allowed for this deployment.',access_denied:'Your role cannot change public ordering.'})[caught.message]||caught.message||'The public ordering settings could not be saved.';}
async function saveSettings(){
  if(busy.value)return;
  if(contrastIssues.value.length){error.value=contrastIssues.value[0];saved.value='';return;}
  busy.value=true;error.value='';saved.value='';
  try{const result=await api(base(),{method:'PUT',body:{published:!!storefront.value.published,deliveryEnabled:!!storefront.value.deliveryEnabled,hostname:storefront.value.hostname.trim().toLowerCase(),displayName:storefront.value.displayName.trim(),description:storefront.value.description.trim(),pickupInstructions:storefront.value.pickupInstructions.trim(),orderExpiryMinutes:Number(storefront.value.orderExpiryMinutes),maxOrderItems:Number(storefront.value.maxOrderItems),maxItemQuantity:Number(storefront.value.maxItemQuantity),maxOrderValue:Number(storefront.value.maxOrderValue),guestContactRetentionDays:Number(storefront.value.guestContactRetentionDays),privacyControllerName:storefront.value.privacyControllerName.trim(),privacyControllerContact:storefront.value.privacyControllerContact.trim(),privacyNoticeUrl:storefront.value.privacyNoticeUrl.trim(),privacyNoticeEn:storefront.value.privacyNoticeEn.trim(),privacyNoticeMs:storefront.value.privacyNoticeMs.trim(),logoUrl:storefront.value.logoUrl.trim(),themePrimaryColor:storefront.value.themePrimaryColor,themeAccentColor:storefront.value.themeAccentColor,themeBackgroundColor:storefront.value.themeBackgroundColor,themeTextColor:storefront.value.themeTextColor,themeFontFamily:storefront.value.themeFontFamily,heroEyebrow:storefront.value.heroEyebrow.trim(),heroTitle:storefront.value.heroTitle.trim(),heroDescription:storefront.value.heroDescription.trim(),heroImageUrl:storefront.value.heroImageUrl.trim(),carouselIntervalSeconds:Number(storefront.value.carouselIntervalSeconds),slides:slides.value.map((row,index)=>({id:row.id||crypto.randomUUID(),published:!!row.published,sortOrder:Number(row.sortOrder??index),badge:row.badge.trim(),title:row.title.trim(),description:row.description.trim(),imageUrl:row.imageUrl.trim(),backgroundColor:row.backgroundColor,ctaLabel:row.ctaLabel.trim(),ctaUrl:row.ctaUrl.trim()}))}});hydrate(result);saved.value=storefront.value.published?'Online ordering is published.':'Storefront settings saved; public ordering remains off.';Store.notify(saved.value);}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
function addSlide(){slides.value.push({id:crypto.randomUUID(),published:true,sortOrder:slides.value.length,badge:'FEATURED',title:'New promotion',description:'',imageUrl:'',backgroundColor:storefront.value.themePrimaryColor,ctaLabel:'',ctaUrl:''});}
function removeSlide(index){slides.value.splice(index,1);}
function applyTheme(preset){storefront.value.themePrimaryColor=preset.primary;storefront.value.themeAccentColor=preset.accent;storefront.value.themeBackgroundColor=preset.background;storefront.value.themeTextColor=preset.text;}
function exactSen(value,label){if(value===''||value===null||value===undefined)return null;const raw=String(value).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(raw))throw new Error(`${label} must have no more than two decimal places.`);const [whole,fraction='']=raw.split('.');const sen=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(sen)||sen<0||sen>100000000)throw new Error(`${label} is outside the allowed range.`);return sen;}
function newDeliveryZone(){deliveryEditor.value={_new:true,name:'',fee:0,minimumOrder:0,leadTimeMinutes:45,serviceInstructions:'',enabled:false};error.value='';}
function editDeliveryZone(row){deliveryEditor.value={...row};error.value='';}
async function saveDeliveryZone(){
  if(busy.value||!deliveryEditor.value)return;busy.value=true;error.value='';
  const row=deliveryEditor.value,rawFee=Number(row.fee)*100,rawMinimum=Number(row.minimumOrder)*100,feeSen=Math.round(rawFee),minimumOrderSen=Math.round(rawMinimum);
  if(!Number.isSafeInteger(feeSen)||feeSen<0||Math.abs(rawFee-feeSen)>1e-6||!Number.isSafeInteger(minimumOrderSen)||minimumOrderSen<0||Math.abs(rawMinimum-minimumOrderSen)>1e-6){error.value='Enter valid delivery amounts with no more than two decimal places.';busy.value=false;return;}
  const body={name:row.name.trim(),feeSen,minimumOrderSen,leadTimeMinutes:Number(row.leadTimeMinutes),serviceInstructions:row.serviceInstructions.trim(),enabled:!!row.enabled};
  try{const result=await api(`${base()}/delivery-zones${row._new?'':`/${encodeURIComponent(row.id)}`}`,{method:row._new?'POST':'PATCH',body});hydrate(result);deliveryEditor.value=null;Store.notify(row._new?'Delivery zone created.':'Delivery zone updated.');}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
async function toggleDeliveryZone(row){deliveryEditor.value={...row,enabled:!row.enabled};await saveDeliveryZone();}
function newLocation(){locationEditor.value={_new:true,name:'Main counter',fulfillmentMode:'pickup',tableLabel:'',pickupInstructions:'',active:true};error.value='';}
function editLocation(row){locationEditor.value={...row};error.value='';}
async function saveLocation(){
  if(busy.value||!locationEditor.value)return;busy.value=true;error.value='';
  const row=locationEditor.value,body={name:row.name.trim(),fulfillmentMode:row.fulfillmentMode,tableLabel:row.tableLabel.trim(),pickupInstructions:row.pickupInstructions.trim(),...(!row._new?{active:!!row.active}:{})};
  try{const result=await api(`${base()}/locations${row._new?'':`/${encodeURIComponent(row.id)}`}`,{method:row._new?'POST':'PATCH',body});locationEditor.value=null;if(result.locationToken)await revealQr(result,row.name);await load();Store.notify(row._new?'Shop location created. Save its QR now.':'Shop location updated.');}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
async function toggleLocation(row){
  if(busy.value)return;busy.value=true;error.value='';
  const changed={...row,active:!row.active};
  try{const result=await api(`${base()}/locations/${encodeURIComponent(row.id)}`,{method:'PATCH',body:{name:changed.name,fulfillmentMode:changed.fulfillmentMode,tableLabel:changed.tableLabel||'',pickupInstructions:changed.pickupInstructions||'',active:changed.active}});hydrate(result);Store.notify(changed.active?'Shop location activated.':'Shop location paused.');}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
async function rotate(row){
  if(busy.value)return;busy.value=true;error.value='';
  try{const result=await api(`${base()}/locations/${encodeURIComponent(row.id)}/rotate-token`,{method:'POST',body:{}});await revealQr(result,row.name);await load();Store.notify('A new shop QR was created. The previous QR no longer works.');}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
async function revealQr(result,name){
  if(!result.orderUrl){error.value='The location was saved, but its QR needs a saved public hostname first.';return;}
  qr.value={name,url:result.orderUrl,tokenHint:(result.locationToken||'').slice(-6)};
  qrImage.value=await QRCode.toDataURL(result.orderUrl,{width:720,margin:3,errorCorrectionLevel:'M'});
}
async function revealGeneralQr(){
  if(!shopUrl.value){error.value='Save the public hostname before creating the reusable shop QR.';return;}
  qr.value={name:'Online shop',url:shopUrl.value,general:true};
  qrImage.value=await QRCode.toDataURL(shopUrl.value,{width:720,margin:3,errorCorrectionLevel:'H'});
}
function closeQr(){qr.value=null;qrImage.value='';document.body.classList.remove('ed-print-shop-qr');}
function downloadQr(){const a=document.createElement('a');a.href=qrImage.value;a.download=`${(props.company.slug||props.company.name||'shop').replace(/[^a-z0-9-]+/gi,'-').toLowerCase()}-${qr.value.name.replace(/[^a-z0-9-]+/gi,'-').toLowerCase()}-order-qr.png`;a.click();}
async function printQr(){document.body.classList.add('ed-print-shop-qr');await nextTick();window.print();setTimeout(()=>document.body.classList.remove('ed-print-shop-qr'),1000);}
async function saveProduct(row){
  if(productBusy.value)return;productBusy.value=row.productId;error.value='';
  try{const result=await api(`${base()}/products/${encodeURIComponent(row.productId)}`,{method:'PUT',body:{published:!!row.published,soldOut:!!row.soldOut,sortOrder:Number(row.sortOrder||0),displayName:row.displayName.trim(),description:row.description.trim(),variantIds:row.variantIds,onlinePriceSen:exactSen(row.onlinePrice,`${row.productName} online price`),variantOverrides:row.variantPrices.filter(item=>row.variantIds.includes(item.variantId)).map(item=>({variantId:item.variantId,onlinePriceSen:exactSen(item.onlinePrice,`${item.name} online price`)}))}});hydrate(result);Store.notify(`${row.productName} public menu settings saved.`);}
  catch(caught){error.value=message(caught);}finally{productBusy.value='';}
}
watch(()=>props.company.id,load);
onMounted(load);
</script>

<template>
  <section class="mf-storefront-admin ed-section" aria-labelledby="storefront-title">
    <div class="ed-section-head"><div><div class="ed-eyebrow">CUSTOMER ORDERING</div><h2 id="storefront-title">Shop QR and online menu</h2><small>Nothing is public until a manager explicitly turns on “Publish online ordering” and saves.</small></div><span class="ed-pill" :class="{warning:!storefront.published}">{{ storefront.published?'Published':'Private' }}</span></div>
    <div v-if="loading" class="ed-notice" role="status">Loading public ordering settings…</div>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p><p v-if="saved" class="ed-notice" role="status">{{ saved }}</p>
    <div v-if="!loading" class="mf-storefront-workbench">
      <aside class="mf-setup-card" aria-label="Storefront setup progress">
        <div><span>STORE READINESS</span><strong>{{ readySteps }} of {{ setupSteps.length }} ready</strong></div>
        <div class="mf-setup-progress" role="progressbar" :aria-valuenow="readySteps" aria-valuemin="0" :aria-valuemax="setupSteps.length"><i :style="{width:`${readySteps/setupSteps.length*100}%`}"></i></div>
        <button v-for="step in setupSteps" :key="step.label" type="button" @click="editorPanel=step.panel"><Icon :name="step.ready?'check':'arrow-right'"/><span>{{ step.label }}</span><small>{{ step.ready?'Ready':'Finish setup' }}</small></button>
      </aside>
      <nav class="mf-editor-tabs" aria-label="Storefront editor sections">
        <button v-for="panel in editorPanels" :key="panel.id" type="button" :class="{active:editorPanel===panel.id}" :aria-current="editorPanel===panel.id?'page':undefined" @click="editorPanel=panel.id"><strong>{{ panel.label }}</strong><small>{{ panel.hint }}</small></button>
      </nav>
    </div>
    <form v-if="!loading" @submit.prevent="saveSettings">
      <div v-show="editorPanel==='basics'" class="ed-editor-section mf-panel-card">
        <div class="ed-section-head"><div><h3>Open your online shop</h3><small>Set the name customers see, explain collection, then add at least one pickup point below.</small></div><span class="ed-pill" :class="{warning:!storefront.published}">{{ storefront.published?'Accepting orders':'Not published' }}</span></div>
        <div class="ed-form-grid">
        <label class="ed-field wide"><span>Public order hostname</span><input v-model.trim="storefront.hostname" maxlength="253" placeholder="order-workspace-brand.finn3.com" :disabled="busy"><small>Use a dedicated order- address. DNS and the Cloudflare tunnel must route this host before customers can open it.</small></label>
        <label class="ed-field"><span>Public shop name</span><input v-model="storefront.displayName" maxlength="120" :placeholder="company.name" :disabled="busy"></label>
        <label class="ed-field"><span>Unpaid order expires after</span><div class="mf-field-suffix"><input v-model.number="storefront.orderExpiryMinutes" type="number" min="5" max="1440" step="1" :disabled="busy"><span>minutes</span></div></label>
        <label class="ed-field wide"><span>Menu introduction</span><textarea v-model="storefront.description" maxlength="2000" rows="3" :disabled="busy"></textarea></label>
        <label class="ed-field wide"><span>Pickup instructions</span><textarea v-model="storefront.pickupInstructions" maxlength="2000" rows="3" :disabled="busy"></textarea></label>
        <label class="mf-switch-field"><input v-model="storefront.deliveryEnabled" type="checkbox" :disabled="busy"><span><strong>Offer delivery</strong><small>Disabled by default. Requires at least one enabled delivery zone. Customers choose payment after staff accepts the order, based on the methods enabled for this shop.</small></span></label>
        <label class="mf-switch-field"><input v-model="storefront.published" type="checkbox" :disabled="busy"><span><strong>Publish online ordering</strong><small>Requires a saved host and at least one active location. Customers can submit unpaid requests immediately after saving.</small></span></label>
        </div>
      </div>
      <section v-show="editorPanel==='appearance'" class="ed-editor-section mf-panel-card">
        <div class="ed-section-head"><div><h3>Brand and storefront hero</h3><small>Colors and content are bounded before they reach the public page. The preview updates as you type.</small></div><div class="ed-actions"><button class="ed-btn small" type="button" :disabled="!hostReady" @click="revealGeneralQr"><Icon name="qr"/>General shop QR</button><a v-if="displayUrl" class="ed-btn small" :href="displayUrl" target="_blank" rel="noopener">Open big display ↗</a></div></div>
        <div class="mf-appearance-tools"><div><span>COLOR STARTERS</span><button v-for="preset in themePresets" :key="preset.name" type="button" @click="applyTheme(preset)"><i :style="{background:preset.primary}"></i>{{ preset.name }}</button></div><div><span>PREVIEW</span><button type="button" :class="{active:previewDevice==='mobile'}" @click="previewDevice='mobile'">Mobile</button><button type="button" :class="{active:previewDevice==='desktop'}" @click="previewDevice='desktop'">Desktop</button></div></div>
        <div class="mf-storefront-design">
          <div class="ed-form-grid">
            <label class="ed-field"><span>Logo URL · HTTPS</span><input v-model="storefront.logoUrl" type="url" maxlength="2048" placeholder="https://…"></label>
            <label class="ed-field"><span>Hero image URL · HTTPS</span><input v-model="storefront.heroImageUrl" type="url" maxlength="2048" placeholder="https://…"></label>
            <label class="ed-field"><span>Primary color</span><input v-model="storefront.themePrimaryColor" type="color"></label>
            <label class="ed-field"><span>Accent color</span><input v-model="storefront.themeAccentColor" type="color"></label>
            <label class="ed-field"><span>Background color</span><input v-model="storefront.themeBackgroundColor" type="color"></label>
            <label class="ed-field"><span>Text color</span><input v-model="storefront.themeTextColor" type="color"></label>
            <div v-if="contrastIssues.length" class="ed-notice warning wide" role="alert"><Icon name="alert"/><div><strong>Improve color contrast before saving</strong><span v-for="issue in contrastIssues" :key="issue">{{ issue }}</span></div></div>
            <label class="ed-field"><span>Display typeface</span><select v-model="storefront.themeFontFamily"><option value="geist">Geist</option><option value="system">System sans</option><option value="serif">Editorial serif</option></select></label>
            <label class="ed-field"><span>Carousel timing</span><div class="mf-field-suffix"><input v-model.number="storefront.carouselIntervalSeconds" type="number" min="3" max="30" step="1"><span>seconds</span></div></label>
            <label class="ed-field"><span>Hero eyebrow</span><input v-model="storefront.heroEyebrow" maxlength="80"></label>
            <label class="ed-field"><span>Hero title</span><input v-model="storefront.heroTitle" maxlength="160" :placeholder="storefront.displayName||company.name"></label>
            <label class="ed-field wide"><span>Hero description</span><textarea v-model="storefront.heroDescription" maxlength="1000" rows="3"></textarea></label>
          </div>
          <div class="mf-preview-stage"><article class="mf-storefront-preview" :class="`is-${previewDevice}`" :style="previewStyle"><div class="mf-preview-brand"><img v-if="storefront.logoUrl" :src="storefront.logoUrl" alt="" referrerpolicy="no-referrer"><strong>{{ storefront.displayName||company.name }}</strong></div><div class="mf-preview-hero"><span>{{ storefront.heroEyebrow }}</span><h4>{{ storefront.heroTitle||storefront.displayName||company.name }}</h4><p>{{ storefront.heroDescription||storefront.description||'Choose your favourites and order ahead.' }}</p><button type="button">Browse menu</button></div><div v-if="previewSlide" class="mf-preview-promo" :style="{backgroundColor:previewSlide.backgroundColor}"><small>{{ previewSlide.badge }}</small><strong>{{ previewSlide.title }}</strong></div></article></div>
        </div>
      </section>
      <section v-show="editorPanel==='promotions'" class="ed-editor-section mf-panel-card">
        <div class="ed-section-head"><div><h3>Promotional carousel</h3><small>Create clear offers for the mobile storefront and full-screen shop display.</small></div><button class="ed-btn small" type="button" :disabled="slides.length>=12" @click="addSlide"><Icon name="plus"/>Add promotion</button></div>
        <div v-if="!slides.length" class="ed-empty"><Icon name="image"/><h3>No promotions yet.</h3><p>Add a promotion when you have an offer to feature. Your menu works without one.</p></div>
        <article v-for="(slide,index) in slides" :key="slide.id" class="mf-slide-editor"><header><strong>Slide {{ index+1 }}</strong><label><input v-model="slide.published" type="checkbox"> Published</label><button class="ed-btn small danger" type="button" @click="removeSlide(index)">Remove</button></header><div class="ed-form-grid"><label class="ed-field"><span>Badge</span><input v-model="slide.badge" maxlength="80"></label><label class="ed-field"><span>Title</span><input v-model="slide.title" required maxlength="160"></label><label class="ed-field wide"><span>Description</span><textarea v-model="slide.description" maxlength="1000" rows="2"></textarea></label><label class="ed-field"><span>Image URL · HTTPS</span><input v-model="slide.imageUrl" type="url" maxlength="2048" placeholder="https://…"></label><label class="ed-field"><span>Background</span><input v-model="slide.backgroundColor" type="color"></label><label class="ed-field"><span>Button label · optional</span><input v-model="slide.ctaLabel" maxlength="60"></label><label class="ed-field"><span>Button destination</span><input v-model="slide.ctaUrl" maxlength="2048" placeholder="/shop or https://…"></label></div></article>
      </section>
      <section v-show="editorPanel==='advanced'" class="ed-editor-section mf-panel-card">
        <div class="ed-section-head"><div><h3>Order safeguards</h3><small>These limits prevent accidental or unusually large unpaid orders.</small></div></div>
        <div class="ed-form-grid">
          <label class="ed-field"><span>Maximum line items</span><input v-model.number="storefront.maxOrderItems" type="number" min="1" max="100" step="1" :disabled="busy"></label>
          <label class="ed-field"><span>Maximum quantity per item</span><input v-model.number="storefront.maxItemQuantity" type="number" min="0.001" max="1000" step="0.001" :disabled="busy"></label>
          <label class="ed-field"><span>Maximum unpaid order value ({{ currency }})</span><input v-model.number="storefront.maxOrderValue" type="number" min="0.01" max="1000000" step="0.01" :disabled="busy"></label>
        </div>
        <div class="ed-section-head"><div><h3>Customer privacy notice</h3><small>Required before publishing. Order contact details and free-form notes are removed from completed, cancelled and expired orders after the retention period.</small></div></div>
        <div class="ed-form-grid">
          <label class="ed-field"><span>Privacy controller name</span><input v-model="storefront.privacyControllerName" maxlength="160" placeholder="Bayam Food Services Sdn Bhd" :disabled="busy"></label>
          <label class="ed-field"><span>Privacy contact</span><input v-model="storefront.privacyControllerContact" maxlength="254" placeholder="privacy@example.com or +60…" :disabled="busy"></label>
          <label class="ed-field wide"><span>Full privacy notice URL</span><input v-model="storefront.privacyNoticeUrl" type="url" maxlength="2048" placeholder="https://example.com/privacy" :disabled="busy"><small>The link must use HTTPS.</small></label>
          <label class="ed-field wide"><span>Short notice · English</span><textarea v-model="storefront.privacyNoticeEn" maxlength="2000" rows="3" placeholder="We use your contact details to prepare and update you about this order." :disabled="busy"></textarea></label>
          <label class="ed-field wide"><span>Notis ringkas · Bahasa Melayu</span><textarea v-model="storefront.privacyNoticeMs" maxlength="2000" rows="3" placeholder="Kami menggunakan butiran hubungan anda untuk menyediakan dan memberi kemas kini tentang pesanan ini." :disabled="busy"></textarea></label>
          <label class="ed-field"><span>Remove order contact after</span><div class="mf-field-suffix"><input v-model.number="storefront.guestContactRetentionDays" type="number" min="7" max="3650" step="1" :disabled="busy"><span>days</span></div><small>This does not remove totals, line items, payment links or status history.</small></label>
        </div>
      </section>
      <div class="mf-editor-save"><span>{{ saved||'Changes are private until you save.' }}</span><button class="ed-btn primary" type="submit" :disabled="busy||!Store.state.online"><Icon name="check"/>{{ busy?'Saving…':'Save storefront' }}</button></div>
    </form>

    <section v-if="!loading" v-show="editorPanel==='basics'" class="ed-editor-section mf-panel-card"><div class="ed-section-head"><div><h3>Pickup points and table QR codes</h3><small>{{ hostReady?'Use the reusable shop QR for banners. A location QR can identify a counter, collection point, or table.':'Save the public hostname above before creating a QR.' }}</small></div><div class="ed-actions"><button class="ed-btn" :disabled="busy||!hostReady" @click="revealGeneralQr"><Icon name="qr"/>Shop QR</button><button class="ed-btn" :disabled="busy||!Store.state.online||!hostReady" @click="newLocation"><Icon name="plus"/>Add pickup point</button></div></div>
      <div v-for="row in locations" :key="row.id" class="ed-row mf-location-row"><span class="ed-avatar"><Icon name="qr"/></span><div><strong>{{ row.name }}</strong><small>{{ row.fulfillmentMode==='both'?'Pickup and table':row.fulfillmentMode==='table'?'At-premise table':'Pickup' }}<template v-if="row.tableLabel"> · {{ row.tableLabel }}</template> · QR …{{ row.tokenHint }}</small><small>{{ row.active?'Accepting scans':'Paused' }} · token version {{ row.tokenVersion }}</small></div><span class="ed-pill" :class="{warning:!row.active}">{{ row.active?'Active':'Paused' }}</span><div class="ed-actions"><button class="ed-btn small" @click="editLocation(row)">Edit</button><button class="ed-btn small" :disabled="busy" @click="toggleLocation(row)">{{ row.active?'Pause':'Activate' }}</button><button class="ed-btn small" :disabled="busy||!hostReady" @click="rotate(row)"><Icon name="qr"/>New QR</button></div></div>
      <div v-if="!locations.length" class="ed-empty"><Icon name="pin"/><h3>No shop location yet.</h3><p>Create the counter, pickup point, or table group customers will scan.</p></div>
    </section>

    <section v-if="!loading" v-show="editorPanel==='basics'" class="ed-editor-section mf-panel-card"><div class="ed-section-head"><div><h3>Delivery areas</h3><small>Add only the areas you can serve. Fees and minimum orders stay hidden until you enable delivery.</small></div><button class="ed-btn" :disabled="busy||!Store.state.online" @click="newDeliveryZone"><Icon name="plus"/>Add delivery area</button></div>
      <div v-for="row in deliveryZones" :key="row.id" class="ed-row mf-location-row"><span class="ed-avatar"><Icon name="pin"/></span><div><strong>{{ row.name }}</strong><small>{{ money(row.fee,currency) }} delivery · {{ money(row.minimumOrder,currency) }} minimum · {{ row.leadTimeMinutes }} min</small><small v-if="row.serviceInstructions">{{ row.serviceInstructions }}</small></div><span class="ed-pill" :class="{warning:!row.enabled}">{{ row.enabled?'Enabled':'Hidden' }}</span><div class="ed-actions"><button class="ed-btn small" :disabled="busy" @click="editDeliveryZone(row)">Edit</button><button class="ed-btn small" :disabled="busy" @click="toggleDeliveryZone(row)">{{ row.enabled?'Disable':'Enable' }}</button></div></div>
      <div v-if="!deliveryZones.length" class="ed-empty"><Icon name="pin"/><h3>No delivery zones.</h3><p>Pickup and table ordering continue unchanged. Create a zone before enabling delivery.</p></div>
    </section>

    <section v-if="!loading" v-show="editorPanel==='menu'" class="ed-editor-section mf-panel-card"><div class="ed-section-head"><div><h3>Customer menu</h3><small>Choose which products customers can order and set an online price only when it differs from the store price.</small></div><span>{{ products.filter(row=>row.published&&!row.soldOut).length }} live</span></div>
      <div class="mf-menu-tools"><label><Icon name="search"/><input v-model="menuSearch" type="search" placeholder="Find a product"></label><div><button type="button" :class="{active:menuFilter==='all'}" @click="menuFilter='all'">All</button><button type="button" :class="{active:menuFilter==='live'}" @click="menuFilter='live'">Live</button><button type="button" :class="{active:menuFilter==='hidden'}" @click="menuFilter='hidden'">Hidden</button></div></div>
      <div v-for="row in filteredProducts" :key="row.productId" class="mf-public-product"><div class="mf-public-product-head"><div><strong>{{ row.productName }}</strong><small>{{ row.product.category || 'Uncategorised' }}</small></div><div class="ed-actions"><label><input v-model="row.published" type="checkbox"> Published</label><label><input v-model="row.soldOut" type="checkbox"> Sold out</label></div></div><div class="ed-form-grid"><label class="ed-field"><span>Public name (optional)</span><input v-model="row.displayName" maxlength="120" :placeholder="row.productName"></label><label class="ed-field"><span>Menu order</span><input v-model.number="row.sortOrder" type="number" min="-1000000" max="1000000" step="1"></label><label class="ed-field wide"><span>Public description</span><textarea v-model="row.description" maxlength="2000" rows="2"></textarea></label></div><div class="mf-channel-price"><div><span>{{ row.product.variants?.length ? 'Catalog base price' : 'Store price' }}</span><strong>{{ money(Number(row.storePriceSen??Math.round(Number(row.product.price)*100))/100,currency) }}</strong></div><label class="ed-field"><span>{{ row.product.variants?.length ? 'Default online option price · optional' : 'Online price · optional' }}</span><input v-model="row.onlinePrice" inputmode="decimal" placeholder="Same as store"><small>{{ row.product.variants?.length ? 'Blank keeps each option at its store price unless overridden below.' : 'Exact currency amount, up to 2 decimals.' }}</small></label><button v-if="row.onlinePrice!==''" type="button" class="ed-btn small" @click="row.onlinePrice=''">Reset to store price</button></div><fieldset v-if="row.product.variants?.length" class="mf-variant-prices"><legend>Available options and channel prices</legend><div v-for="variant in row.variantPrices" :key="variant.variantId"><label class="mf-variant-toggle"><input v-model="row.variantIds" type="checkbox" :value="variant.variantId"><strong>{{ variant.name }}</strong></label><span>Store {{ money(variant.storePrice,currency) }}</span><label class="ed-field"><span>Online price</span><input v-model="variant.onlinePrice" inputmode="decimal" :disabled="!row.variantIds.includes(variant.variantId)" placeholder="Same as store"></label><button v-if="variant.onlinePrice!==''" type="button" class="ed-btn small" @click="variant.onlinePrice=''">Reset</button></div></fieldset><div class="ed-actions"><button class="ed-btn small" :disabled="productBusy===row.productId||!Store.state.online" @click="saveProduct(row)">{{ productBusy===row.productId?'Saving…':'Save menu item' }}</button></div></div>
      <div v-if="products.length&&!filteredProducts.length" class="ed-empty"><Icon name="search"/><h3>No matching products.</h3><p>Clear the search or choose another filter.</p></div>
      <div v-if="!products.length" class="ed-empty"><Icon name="box"/><h3>No inventory products.</h3><p>Add products before building the public menu.</p></div>
    </section>

    <Modal v-if="locationEditor" :title="locationEditor._new?'Create shop location':'Edit shop location'" :busy="busy" @close="locationEditor=null">
      <div class="ed-form-grid"><label class="ed-field wide"><span>Location name</span><input v-model="locationEditor.name" required maxlength="120" placeholder="Main counter"></label><label class="ed-field"><span>Order mode</span><select v-model="locationEditor.fulfillmentMode"><option value="pickup">Pickup</option><option value="table">At-premise table</option><option value="both">Pickup and table</option></select></label><label class="ed-field"><span>Table / zone label</span><input v-model="locationEditor.tableLabel" maxlength="80" placeholder="Patio tables"></label><label class="ed-field wide"><span>Location instructions</span><textarea v-model="locationEditor.pickupInstructions" maxlength="1000" rows="3"></textarea></label></div>
      <template #actions><button class="ed-btn" :disabled="busy" @click="locationEditor=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!locationEditor.name.trim()" @click="saveLocation">{{ locationEditor._new?'Create and reveal QR':'Save location' }}</button></template>
    </Modal>
    <Modal v-if="deliveryEditor" :title="deliveryEditor._new?'Create delivery zone':'Edit delivery zone'" :busy="busy" @close="deliveryEditor=null">
      <div class="ed-form-grid"><label class="ed-field wide"><span>Zone name</span><input v-model="deliveryEditor.name" required maxlength="120" placeholder="Within 5 km"></label><label class="ed-field"><span>Flat delivery fee ({{ currency }})</span><input v-model.number="deliveryEditor.fee" type="number" min="0" max="1000000" step="0.01"></label><label class="ed-field"><span>Minimum merchandise order ({{ currency }})</span><input v-model.number="deliveryEditor.minimumOrder" type="number" min="0" max="1000000" step="0.01"></label><label class="ed-field"><span>Estimated lead time</span><div class="mf-field-suffix"><input v-model.number="deliveryEditor.leadTimeMinutes" type="number" min="5" max="1440" step="1"><span>minutes</span></div></label><label class="ed-field wide"><span>Customer instructions</span><textarea v-model="deliveryEditor.serviceInstructions" maxlength="1000" rows="3" placeholder="Coverage, handoff, or delivery conditions"></textarea></label><label class="mf-switch-field wide"><input v-model="deliveryEditor.enabled" type="checkbox"><span><strong>Show this zone to customers</strong><small>The storefront-level delivery switch must also be on.</small></span></label></div>
      <template #actions><button class="ed-btn" :disabled="busy" @click="deliveryEditor=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!deliveryEditor.name.trim()" @click="saveDeliveryZone">{{ deliveryEditor._new?'Create zone':'Save zone' }}</button></template>
    </Modal>
    <Modal v-if="qr" :title="qr.general?'Reusable online shop QR':'Save this location QR now'" :busy="false" @close="closeQr">
      <div class="mf-shop-qr-sheet"><img :src="qrImage" :alt="`Order QR for ${qr.name}`"><h3>{{ company.name }}</h3><p>{{ qr.name }}</p><strong>Scan to view the menu and order</strong><small>{{ qr.url }}</small></div>
      <div v-if="qr.general" class="ed-notice"><Icon name="check"/><div><strong>This QR always opens the general shop.</strong>Use it on reusable banners, signs, social posts, and the full-screen display.</div></div><div v-else class="ed-notice warning"><Icon name="alert"/><div><strong>The full location token is shown only now.</strong>Download or print this QR before closing. Creating a new QR later invalidates this one.</div></div>
      <template #actions><button class="ed-btn" @click="closeQr">Close</button><button class="ed-btn" @click="printQr"><Icon name="printer"/>Print</button><button class="ed-btn primary" @click="downloadQr"><Icon name="download"/>Download PNG</button></template>
    </Modal>
  </section>
</template>

<style scoped>
.mf-storefront-admin{max-width:1200px}.mf-storefront-workbench{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;margin:20px 0}.mf-setup-card{display:grid;gap:8px;padding:16px;border:1px solid var(--ed-line);border-radius:14px;background:var(--ed-soft)}.mf-setup-card>div:first-child{display:flex;justify-content:space-between;align-items:center;gap:12px}.mf-setup-card>div>span{font-size:9px;letter-spacing:.12em;color:var(--ed-muted)}.mf-setup-card>div>strong{font-size:11px}.mf-setup-progress{height:5px;overflow:hidden;border-radius:99px;background:var(--ed-line)}.mf-setup-progress i{display:block;height:100%;border-radius:inherit;background:var(--ed-accent)}.mf-setup-card>button{display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:8px;min-height:38px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}.mf-setup-card>button:hover{background:var(--ed-bg)}.mf-setup-card>button span{font-size:11px}.mf-setup-card>button small{font-size:9px;color:var(--ed-muted)}.mf-editor-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.mf-editor-tabs button{display:grid;gap:4px;align-content:center;min-height:72px;padding:12px;border:1px solid var(--ed-line);border-radius:12px;background:var(--ed-bg);color:inherit;text-align:left;cursor:pointer}.mf-editor-tabs button:hover,.mf-editor-tabs button.active{border-color:var(--ed-accent);background:var(--ed-soft)}.mf-editor-tabs button.active{box-shadow:inset 0 -3px var(--ed-accent)}.mf-editor-tabs strong{font-size:11px}.mf-editor-tabs small{font-size:9px;line-height:1.35;color:var(--ed-muted)}.mf-panel-card{border:1px solid var(--ed-line);border-radius:14px;padding:20px}.mf-editor-save{position:sticky;bottom:12px;z-index:4;display:flex;align-items:center;justify-content:flex-end;gap:18px;margin:18px 0;padding:12px 14px;border:1px solid var(--ed-line);border-radius:12px;background:color-mix(in srgb,var(--ed-bg) 94%,transparent);box-shadow:0 12px 34px #162e221a;backdrop-filter:blur(12px)}.mf-editor-save span{margin-right:auto;font-size:10px;color:var(--ed-muted)}.mf-menu-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0}.mf-menu-tools>label{display:flex;align-items:center;gap:8px;flex:1;max-width:420px;min-height:40px;padding:0 12px;border:1px solid var(--ed-line);border-radius:9px;background:var(--ed-bg)}.mf-menu-tools input{width:100%;border:0;outline:0;background:transparent;color:inherit}.mf-menu-tools>div{display:flex;padding:3px;border:1px solid var(--ed-line);border-radius:9px}.mf-menu-tools button{min-height:32px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:10px;cursor:pointer}.mf-menu-tools button.active{background:var(--ed-accent);color:#fff}.mf-appearance-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0;padding:10px 12px;border:1px solid var(--ed-line);border-radius:10px;background:var(--ed-soft)}.mf-appearance-tools>div{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.mf-appearance-tools span{font-size:9px;letter-spacing:.1em;color:var(--ed-muted);margin-right:4px}.mf-appearance-tools button{display:flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--ed-line);border-radius:7px;background:var(--ed-bg);color:inherit;font-size:10px;cursor:pointer}.mf-appearance-tools button.active{border-color:var(--ed-accent);box-shadow:inset 0 -2px var(--ed-accent)}.mf-appearance-tools i{width:10px;height:10px;border-radius:50%}.mf-storefront-design{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:24px;align-items:start}.mf-storefront-design .ed-notice span{display:block}.mf-preview-stage{display:flex;justify-content:center;min-width:0}.mf-storefront-preview{width:100%;position:sticky;top:20px;min-height:430px;border:1px solid var(--ed-line);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px #16352812;transition:max-width .2s ease}.mf-storefront-preview.is-mobile{max-width:360px}.mf-preview-brand{display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid #00000012}.mf-preview-brand img{width:34px;height:34px;object-fit:contain;border-radius:7px}.mf-preview-hero{padding:38px 26px}.mf-preview-hero>span{color:var(--preview-primary);font-size:9px;letter-spacing:.16em;font-weight:800}.mf-preview-hero h4{margin:10px 0 12px;font:600 38px/1.02 inherit;letter-spacing:-.035em}.mf-preview-hero p{font-size:11px;line-height:1.55;opacity:.7}.mf-preview-hero button{margin-top:16px;border:0;border-radius:999px;background:var(--preview-primary);color:#fff;padding:10px 16px;font:700 10px inherit}.mf-preview-promo{display:flex;flex-direction:column;gap:4px;margin:0 18px 18px;padding:18px;border-radius:10px;color:#fff}.mf-preview-promo small{font-size:8px;letter-spacing:.14em}.mf-preview-promo strong{font-size:16px}.mf-slide-editor{border:1px solid var(--ed-line);border-radius:10px;padding:16px;margin-top:10px}.mf-slide-editor>header{display:flex;align-items:center;gap:14px;margin-bottom:14px}.mf-slide-editor>header>strong{margin-right:auto}.mf-slide-editor>header label{display:flex;align-items:center;gap:6px;font-size:10px}.mf-channel-price{display:grid;grid-template-columns:minmax(140px,.45fr) minmax(220px,1fr) auto;gap:14px;align-items:end;padding:15px;background:var(--ed-soft);border:1px solid var(--ed-line);border-radius:8px}.mf-channel-price>div{display:grid;gap:6px}.mf-channel-price>div span{font-size:9px;color:var(--ed-muted);text-transform:uppercase;letter-spacing:.08em}.mf-channel-price>div strong{font-size:16px}.mf-variant-prices{display:grid;gap:8px;border:0;padding:0;margin:0}.mf-variant-prices legend{font-size:10px;color:var(--ed-muted);margin-bottom:7px}.mf-variant-prices>div{display:grid;grid-template-columns:minmax(180px,1fr) 120px minmax(180px,.8fr) auto;align-items:end;gap:12px;padding:11px 13px;border:1px solid var(--ed-line);border-radius:8px}.mf-variant-prices>div>span{align-self:center;font-size:10px;color:var(--ed-muted)}.mf-variant-toggle{align-self:center;display:flex;align-items:center;gap:8px;font-size:11px}@media(max-width:1000px){.mf-storefront-workbench{grid-template-columns:1fr}.mf-editor-tabs{grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.mf-storefront-design{grid-template-columns:1fr}.mf-storefront-preview{position:static}.mf-variant-prices>div{grid-template-columns:1fr 1fr}.mf-variant-toggle{grid-column:1/-1}}@media(max-width:600px){.mf-storefront-admin{width:100%}.mf-panel-card{padding:14px}.mf-editor-tabs{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:4px}.mf-editor-tabs button{min-width:145px;scroll-snap-align:start}.mf-appearance-tools{align-items:flex-start;flex-direction:column}.mf-menu-tools{align-items:stretch;flex-direction:column}.mf-menu-tools>label{max-width:none}.mf-menu-tools>div button{flex:1}.mf-channel-price,.mf-variant-prices>div{grid-template-columns:1fr}.mf-variant-toggle{grid-column:auto}.mf-editor-save{bottom:8px}.mf-editor-save span{display:none}}
</style>
