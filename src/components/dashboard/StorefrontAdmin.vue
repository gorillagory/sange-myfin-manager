<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { Store } from '../../store';
import { api } from '../../services/api';
import { money } from '../../domain/pos';
import Icon from '../ui/EditionIcon.vue';
import Modal from '../ui/EditionModal.vue';

const props = defineProps({ company: { type:Object, required:true } });
const loading=ref(false),busy=ref(false),error=ref(''),saved=ref('');
const storefront=ref(defaultSettings()),locations=ref([]),publication=ref(new Map());
const hostSaved=ref(false),savedHostname=ref('');
const locationEditor=ref(null),qr=ref(null),qrImage=ref(''),productBusy=ref('');
const base=()=>`/companies/${encodeURIComponent(props.company.id)}/storefront`;
const currency=computed(()=>props.company.preferences?.currency||'RM');
const hostReady=computed(()=>hostSaved.value&&storefront.value.hostname.trim().toLowerCase()===savedHostname.value);
const products=computed(()=>Store.state.products.map(product=>{
  const current=publication.value.get(product.id)||{};
  return {product,...current,productId:product.id,productName:current.productName||product.name,published:!!current.published,soldOut:!!current.soldOut,sortOrder:Number(current.sortOrder||0),displayName:current.displayName||'',description:current.description||'',variantIds:current.variantIds||current.variants?.filter(x=>x.published).map(x=>x.variantId)||product.variants.map(x=>x.id)};
}));
function defaultSettings(){return {published:false,hostname:'',displayName:'',description:'',pickupInstructions:'',orderExpiryMinutes:30,maxOrderItems:30,maxItemQuantity:20,maxOrderValue:1000,guestContactRetentionDays:90,privacyControllerName:'',privacyControllerContact:'',privacyNoticeUrl:'',privacyNoticeEn:'',privacyNoticeMs:''};}
function suggestedHost(){return props.company.hostname?`order-${props.company.hostname}`:'';}
function hydrate(result){
  hostSaved.value=!!result.storefront?.hostname;savedHostname.value=result.storefront?.hostname||'';
  storefront.value={...defaultSettings(),...(result.storefront||{})};
  if(!storefront.value.hostname)storefront.value.hostname=suggestedHost();
  locations.value=result.locations||[];
  publication.value=new Map((result.products||[]).map(row=>[row.productId,{...row,variantIds:(row.variants||[]).filter(x=>x.published&&!x.soldOut).map(x=>x.variantId)}]));
}
async function load(){loading.value=true;error.value='';try{hydrate(await api(base()));}catch(caught){error.value=message(caught);}finally{loading.value=false;}}
function message(caught){return ({storefront_host_and_location_required:'Create an active shop location before publishing.',storefront_privacy_notice_required:'Add the privacy controller, contact, HTTPS privacy notice URL and both English and Bahasa Melayu short notices before publishing.',hostname_unavailable:'That public order address belongs to another company.',invalid_storefront_hostname:'Use an order-… hostname already allowed for this deployment.',access_denied:'Your role cannot change public ordering.'})[caught.message]||caught.message||'The public ordering settings could not be saved.';}
async function saveSettings(){
  if(busy.value)return;busy.value=true;error.value='';saved.value='';
  try{const result=await api(base(),{method:'PUT',body:{published:!!storefront.value.published,hostname:storefront.value.hostname.trim().toLowerCase(),displayName:storefront.value.displayName.trim(),description:storefront.value.description.trim(),pickupInstructions:storefront.value.pickupInstructions.trim(),orderExpiryMinutes:Number(storefront.value.orderExpiryMinutes),maxOrderItems:Number(storefront.value.maxOrderItems),maxItemQuantity:Number(storefront.value.maxItemQuantity),maxOrderValue:Number(storefront.value.maxOrderValue),guestContactRetentionDays:Number(storefront.value.guestContactRetentionDays),privacyControllerName:storefront.value.privacyControllerName.trim(),privacyControllerContact:storefront.value.privacyControllerContact.trim(),privacyNoticeUrl:storefront.value.privacyNoticeUrl.trim(),privacyNoticeEn:storefront.value.privacyNoticeEn.trim(),privacyNoticeMs:storefront.value.privacyNoticeMs.trim()}});hydrate(result);saved.value=storefront.value.published?'Online ordering is published.':'Storefront settings saved; public ordering remains off.';Store.notify(saved.value);}
  catch(caught){error.value=message(caught);}finally{busy.value=false;}
}
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
function closeQr(){qr.value=null;qrImage.value='';document.body.classList.remove('ed-print-shop-qr');}
function downloadQr(){const a=document.createElement('a');a.href=qrImage.value;a.download=`${(props.company.slug||props.company.name||'shop').replace(/[^a-z0-9-]+/gi,'-').toLowerCase()}-${qr.value.name.replace(/[^a-z0-9-]+/gi,'-').toLowerCase()}-order-qr.png`;a.click();}
async function printQr(){document.body.classList.add('ed-print-shop-qr');await nextTick();window.print();setTimeout(()=>document.body.classList.remove('ed-print-shop-qr'),1000);}
async function saveProduct(row){
  if(productBusy.value)return;productBusy.value=row.productId;error.value='';
  try{const result=await api(`${base()}/products/${encodeURIComponent(row.productId)}`,{method:'PUT',body:{published:!!row.published,soldOut:!!row.soldOut,sortOrder:Number(row.sortOrder||0),displayName:row.displayName.trim(),description:row.description.trim(),variantIds:row.variantIds}});hydrate(result);Store.notify(`${row.productName} public menu settings saved.`);}
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
    <form v-if="!loading" @submit.prevent="saveSettings">
      <div class="ed-form-grid">
        <label class="ed-field wide"><span>Public order hostname</span><input v-model.trim="storefront.hostname" maxlength="253" placeholder="order-workspace-brand.finn3.com" :disabled="busy"><small>Use a dedicated order- address. DNS and the Cloudflare tunnel must route this host before customers can open it.</small></label>
        <label class="ed-field"><span>Public shop name</span><input v-model="storefront.displayName" maxlength="120" :placeholder="company.name" :disabled="busy"></label>
        <label class="ed-field"><span>Unpaid order expires after</span><div class="mf-field-suffix"><input v-model.number="storefront.orderExpiryMinutes" type="number" min="5" max="1440" step="1" :disabled="busy"><span>minutes</span></div></label>
        <label class="ed-field wide"><span>Menu introduction</span><textarea v-model="storefront.description" maxlength="2000" rows="3" :disabled="busy"></textarea></label>
        <label class="ed-field wide"><span>Pickup instructions</span><textarea v-model="storefront.pickupInstructions" maxlength="2000" rows="3" :disabled="busy"></textarea></label>
      </div>
      <div class="ed-form-grid ed-management-space">
        <label class="ed-field"><span>Maximum line items</span><input v-model.number="storefront.maxOrderItems" type="number" min="1" max="100" step="1" :disabled="busy"></label>
        <label class="ed-field"><span>Maximum quantity per item</span><input v-model.number="storefront.maxItemQuantity" type="number" min="0.001" max="1000" step="0.001" :disabled="busy"></label>
        <label class="ed-field"><span>Maximum unpaid order value ({{ currency }})</span><input v-model.number="storefront.maxOrderValue" type="number" min="0.01" max="1000000" step="0.01" :disabled="busy"></label>
        <label class="mf-switch-field"><input v-model="storefront.published" type="checkbox" :disabled="busy"><span><strong>Publish online ordering</strong><small>Requires a saved host and at least one active location. Customers can submit unpaid requests immediately after saving.</small></span></label>
      </div>
      <section class="ed-editor-section">
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
      <div class="ed-actions ed-management-space"><button class="ed-btn primary" type="submit" :disabled="busy||!Store.state.online"><Icon name="check"/>{{ busy?'Saving…':'Save storefront settings' }}</button></div>
    </form>

    <section v-if="!loading" class="ed-editor-section"><div class="ed-section-head"><div><h3>Shop and table QR locations</h3><small>{{ hostReady?'Each location has a revocable token. Rotating it invalidates every old print of that QR.':'Save the public hostname above before creating or rotating a QR.' }}</small></div><button class="ed-btn" :disabled="busy||!Store.state.online||!hostReady" @click="newLocation"><Icon name="plus"/>New location</button></div>
      <div v-for="row in locations" :key="row.id" class="ed-row mf-location-row"><span class="ed-avatar"><Icon name="qr"/></span><div><strong>{{ row.name }}</strong><small>{{ row.fulfillmentMode==='both'?'Pickup and table':row.fulfillmentMode==='table'?'At-premise table':'Pickup' }}<template v-if="row.tableLabel"> · {{ row.tableLabel }}</template> · QR …{{ row.tokenHint }}</small><small>{{ row.active?'Accepting scans':'Paused' }} · token version {{ row.tokenVersion }}</small></div><span class="ed-pill" :class="{warning:!row.active}">{{ row.active?'Active':'Paused' }}</span><div class="ed-actions"><button class="ed-btn small" @click="editLocation(row)">Edit</button><button class="ed-btn small" :disabled="busy" @click="toggleLocation(row)">{{ row.active?'Pause':'Activate' }}</button><button class="ed-btn small" :disabled="busy||!hostReady" @click="rotate(row)"><Icon name="qr"/>New QR</button></div></div>
      <div v-if="!locations.length" class="ed-empty"><Icon name="pin"/><h3>No shop location yet.</h3><p>Create the counter, pickup point, or table group customers will scan.</p></div>
    </section>

    <section v-if="!loading" class="ed-editor-section"><div class="ed-section-head"><div><h3>Public menu</h3><small>Products remain hidden until saved as published. Sold out hides availability without deleting the product.</small></div><span>{{ products.filter(row=>row.published&&!row.soldOut).length }} live</span></div>
      <div v-for="row in products" :key="row.productId" class="mf-public-product"><div class="mf-public-product-head"><div><strong>{{ row.productName }}</strong><small>{{ money(row.product.variants?.length?Math.min(...row.product.variants.map(x=>x.price)):row.product.price,currency) }} · {{ row.product.category || 'Uncategorised' }}</small></div><div class="ed-actions"><label><input v-model="row.published" type="checkbox"> Published</label><label><input v-model="row.soldOut" type="checkbox"> Sold out</label></div></div><div class="ed-form-grid"><label class="ed-field"><span>Public name (optional)</span><input v-model="row.displayName" maxlength="120" :placeholder="row.productName"></label><label class="ed-field"><span>Menu order</span><input v-model.number="row.sortOrder" type="number" min="-1000000" max="1000000" step="1"></label><label class="ed-field wide"><span>Public description</span><textarea v-model="row.description" maxlength="2000" rows="2"></textarea></label></div><fieldset v-if="row.product.variants?.length" class="mf-variant-checks"><legend>Available options</legend><label v-for="variant in row.product.variants" :key="variant.id"><input v-model="row.variantIds" type="checkbox" :value="variant.id">{{ variant.name }}</label></fieldset><div class="ed-actions"><button class="ed-btn small" :disabled="productBusy===row.productId||!Store.state.online" @click="saveProduct(row)">{{ productBusy===row.productId?'Saving…':'Save menu item' }}</button></div></div>
      <div v-if="!products.length" class="ed-empty"><Icon name="box"/><h3>No inventory products.</h3><p>Add products before building the public menu.</p></div>
    </section>

    <Modal v-if="locationEditor" :title="locationEditor._new?'Create shop location':'Edit shop location'" :busy="busy" @close="locationEditor=null">
      <div class="ed-form-grid"><label class="ed-field wide"><span>Location name</span><input v-model="locationEditor.name" required maxlength="120" placeholder="Main counter"></label><label class="ed-field"><span>Order mode</span><select v-model="locationEditor.fulfillmentMode"><option value="pickup">Pickup</option><option value="table">At-premise table</option><option value="both">Pickup and table</option></select></label><label class="ed-field"><span>Table / zone label</span><input v-model="locationEditor.tableLabel" maxlength="80" placeholder="Patio tables"></label><label class="ed-field wide"><span>Location instructions</span><textarea v-model="locationEditor.pickupInstructions" maxlength="1000" rows="3"></textarea></label></div>
      <template #actions><button class="ed-btn" :disabled="busy" @click="locationEditor=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!locationEditor.name.trim()" @click="saveLocation">{{ locationEditor._new?'Create and reveal QR':'Save location' }}</button></template>
    </Modal>
    <Modal v-if="qr" title="Save this shop QR now" :busy="false" @close="closeQr">
      <div class="mf-shop-qr-sheet"><img :src="qrImage" :alt="`Order QR for ${qr.name}`"><h3>{{ company.name }}</h3><p>{{ qr.name }}</p><strong>Scan to view the menu and order</strong><small>{{ qr.url }}</small></div>
      <div class="ed-notice warning"><Icon name="alert"/><div><strong>The full location token is shown only now.</strong>Download or print this QR before closing. Creating a new QR later invalidates this one.</div></div>
      <template #actions><button class="ed-btn" @click="closeQr">Close</button><button class="ed-btn" @click="printQr"><Icon name="printer"/>Print</button><button class="ed-btn primary" @click="downloadQr"><Icon name="download"/>Download PNG</button></template>
    </Modal>
  </section>
</template>
