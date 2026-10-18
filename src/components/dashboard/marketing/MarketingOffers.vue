<script setup>
import { computed, ref } from 'vue';
import QRCode from 'qrcode';
import {
  offerPresentation, promotionCode, promotionShareTarget, suggestPromotionCode,
} from '../../../domain/marketing.js';
import { voucherPayload } from '../../../domain/studentPrograms.js';
import Icon from '../../ui/EditionIcon.vue';
import Modal from '../../ui/EditionModal.vue';

const props=defineProps({
  offers:{type:Array,default:()=>[]}, vouchers:{type:Array,default:()=>[]}, campaigns:{type:Array,default:()=>[]},
  products:{type:Array,default:()=>[]}, currency:{type:String,default:'RM'}, canManage:Boolean, busy:Boolean,
  error:{type:String,default:''},
});
const emit=defineEmits(['new-campaign','save-voucher','rotate-voucher']);
const voucher=ref(null),replacement=ref(null),localError=ref(''),notice=ref(''),share=ref(null),qrData=ref(''),shareBusy=ref(false);
const voucherOffers=computed(()=>props.offers.filter(row=>row.redemptionMode==='voucher'));
const presentation=row=>{const product=props.products.find(item=>item.id===row.rewardProductId),variant=product?.variants?.find(item=>item.id===row.rewardVariantId);return offerPresentation({...row,rewardProductName:product?`${product.name}${variant?` · ${variant.name}`:''}`:''},props.currency);};
const date=value=>value?new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value)):'No expiry';
const localTime=value=>{const parsed=new Date(value||Date.now());const offset=parsed.getTimezoneOffset()*60000;return new Date(parsed-offset).toISOString().slice(0,16);};
const voucherState=row=>{const now=Date.now(),from=new Date(row.validFrom).getTime(),until=row.validUntil?new Date(row.validUntil).getTime():Infinity,exhausted=row.maxRedemptions!=null&&Number(row.redeemedCount)>=Number(row.maxRedemptions);if(!row.enabled)return {label:'Inactive',tone:'warning'};if(exhausted)return {label:'Used up',tone:'warning'};if(from>now)return {label:'Scheduled',tone:''};if(until<=now)return {label:'Expired',tone:'warning'};return {label:'Ready',tone:'ready'};};
const campaignsForOffer=row=>props.campaigns.filter(campaign=>(campaign.promotionLinks||[]).some(link=>(link.promotionId||link.id)===(row.promotionId||row.id)&&Number(link.promotionVersion||link.version)===Number(row.promotionVersion||row.version)));
const voucherWindow=promotionId=>{const offer=voucherOffers.value.find(row=>row.id===promotionId),campaign=campaignsForOffer(offer||{})[0];return {campaignId:campaign?.id||'',validFrom:localTime(campaign?.startsAt||offer?.validFrom),validUntil:(campaign?.endsAt||offer?.validUntil)?localTime(campaign?.endsAt||offer?.validUntil):''};};
const campaignLabel=row=>row.campaignName||campaignsForOffer(row)[0]?.name||'Unlinked offer';
const offerForVoucher=row=>props.offers.find(offer=>(offer.id||offer.promotionId)===(row.promotionId||row.promotion_id));
const codeFor=row=>promotionCode(row);
const shareTarget=row=>promotionShareTarget(row);
const shareIsLink=computed(()=>/^https?:\/\//i.test(shareTarget(share.value||{})));

function openVoucher(row=null,promotionId=''){
  const selected=promotionId||row?.promotionId||voucherOffers.value[0]?.id||'';
  voucher.value=row?{id:row.id,promotionId:selected,campaignId:row.campaignId||'',codeHint:row.codeHint||row.code_hint,displayCode:codeFor(row),expectedVersion:Number(row.version),enabled:!!row.enabled,validFrom:localTime(row.validFrom),validUntil:row.validUntil?localTime(row.validUntil):'',maxRedemptions:row.maxRedemptions??'',perCustomerLimit:row.perCustomerLimit??''}:{promotionId:selected,...voucherWindow(selected),code:'',expectedVersion:0,enabled:true,maxRedemptions:'',perCustomerLimit:'1'};
  localError.value='';notice.value='';
}
function voucherOfferChanged(){if(voucher.value&&!voucher.value.id)Object.assign(voucher.value,voucherWindow(voucher.value.promotionId));}
function generateCode(){
  const offer=voucherOffers.value.find(row=>row.id===voucher.value?.promotionId);
  voucher.value.code=suggestPromotionCode(campaignLabel(offer||{})==='Unlinked offer'?(offer?.name||'PROMO'):campaignLabel(offer),props.vouchers.map(codeFor));
}
function saveVoucher(){
  try{
    const creating=!voucher.value.id,promotionId=voucher.value.promotionId,offer=voucherOffers.value.find(row=>row.id===promotionId),campaignId=voucher.value.campaignId||campaignsForOffer(offer||{})[0]?.id||'',payload=voucherPayload({...voucher.value,campaignId},{creating});
    emit('save-voucher',{promotionId,voucherId:voucher.value.id||'',payload,done:saved=>{
      const result={...(saved||{}),promotionId,displayCode:promotionCode(saved||{})||payload.code};
      voucher.value=null;
      if(creating) openShare(result);
    }});
  }catch(error){localError.value=error.message;}
}
function openReplacement(row){replacement.value={id:row.id,promotionId:row.promotionId,expectedVersion:Number(row.version),code:'',codeHint:row.codeHint||row.code_hint};localError.value='';notice.value='';}
function suggestReplacement(){const offer=offerForVoucher(replacement.value||{});replacement.value.code=suggestPromotionCode(campaignLabel(offer||{})==='Unlinked offer'?(offer?.name||'PROMO'):campaignLabel(offer),props.vouchers.map(codeFor));}
function rotateVoucher(){
  try{
    const code=String(replacement.value.code||'').normalize('NFKC').trim().toLocaleUpperCase('en-US');
    if(!/^[A-Z0-9](?:[A-Z0-9-]{1,30}[A-Z0-9])$/.test(code))throw new Error('Reusable code must start and end with a letter or number and may contain hyphens.');
    emit('rotate-voucher',{promotionId:replacement.value.promotionId,voucherId:replacement.value.id,payload:{expectedVersion:replacement.value.expectedVersion,code},done:saved=>{replacement.value=null;openShare(saved?.voucher||saved||{displayCode:code});}});
  }catch(error){localError.value=error.message;}
}
async function openShare(row){
  share.value={...row,displayCode:codeFor(row)};qrData.value='';localError.value='';notice.value='';
  const target=shareTarget(share.value);
  if(!target)return;
  shareBusy.value=true;
  try{qrData.value=await QRCode.toDataURL(target,{width:320,margin:2,errorCorrectionLevel:'M'});}
  catch{localError.value='The QR image could not be generated. Copy the code or link instead.';}
  finally{shareBusy.value=false;}
}
async function copyText(value,label){
  if(!value)return;
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);
    else{const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}
    notice.value=`${label} copied.`;
  }catch{localError.value=`${label} could not be copied. Select it and copy manually.`;}
}
</script>

<template>
  <section class="mf-offers-panel">
    <div class="ed-section-head"><div><div class="ed-eyebrow">OFFERS &amp; REUSABLE CODES</div><h2>One offer, wherever customers buy</h2><small>Campaigns own the schedule and channels. Reusable codes such as STUDENT-26 or STAFF-26 unlock a linked voucher offer at both POS and the storefront.</small></div><div v-if="canManage" class="ed-actions"><button class="ed-btn" :disabled="!voucherOffers.length" :title="voucherOffers.length?'Create a reusable code':'Create a voucher campaign offer first'" @click="openVoucher()"><Icon name="plus"/>New reusable code</button><button class="ed-btn primary" @click="emit('new-campaign')"><Icon name="spark"/>New campaign</button></div></div>
    <div v-if="canManage&&!voucherOffers.length" class="ed-notice"><Icon name="info"/><div><strong>Create the offer before its code</strong>Start a campaign, choose “Reusable code” under redemption, then save the draft. Its linked offer will appear here so you can create and share a code.</div></div>
    <div class="mf-offer-grid"><article v-for="row in offers" :key="`${row.id}:${row.version}`"><header><Icon :name="row.discountType==='free_item'?'bag':'percent'"/><span class="ed-pill" :class="{ready:row.enabled,warning:!row.enabled}">{{ row.enabled?'Enabled':'Draft / inactive' }}</span></header><div class="mf-offer-link"><span>{{ campaignLabel(row) }}</span><small>Campaign link</small></div><h3>{{ row.name||row.campaignName }}</h3><strong>{{ presentation(row) }}</strong><dl><div><dt>Version</dt><dd>{{ row.version }}</dd></div><div><dt>Redeems</dt><dd>{{ row.redemptionMode==='voucher'?'With reusable code':'Automatically' }}</dd></div><div><dt>Window</dt><dd>{{ date(row.validFrom) }} – {{ date(row.validUntil) }}</dd></div></dl><button v-if="canManage&&row.redemptionMode==='voucher'" class="ed-btn small mf-offer-code-action" type="button" @click="openVoucher(null,row.id)"><Icon name="plus"/>Add code to this offer</button></article></div>
    <div v-if="!offers.length" class="ed-empty"><Icon name="percent"/><h3>No offer versions yet.</h3><p>Start with a campaign. MyFin links the offer to that campaign so it can be found at POS and on the storefront.</p></div>

    <section class="ed-section"><div class="ed-section-head"><div><h3>Reusable codes</h3><small>Copy the code for staff, share its storefront link, or print the QR. Legacy masked codes must be replaced before they can be shared.</small></div><span class="ed-pill">{{ vouchers.length }} code{{ vouchers.length===1?'':'s' }}</span></div>
      <div v-for="row in vouchers" :key="row.id" class="ed-row mf-code-row"><Icon name="qr"/><span class="mf-code-main"><code v-if="codeFor(row)">{{ codeFor(row) }}</code><strong v-else>{{ row.codeHint||row.code_hint||'Legacy masked code' }}</strong><small>{{ row.campaignName||campaignLabel(offerForVoucher(row)||{}) }} · {{ offerForVoucher(row)?.name||row.promotionName||'Voucher offer' }} · {{ date(row.validFrom) }} – {{ date(row.validUntil) }}</small><em v-if="!codeFor(row)" class="mf-legacy-note">Created under the old masked-code model. Replace it to disable the old code and create one staff can copy or share.</em></span><span>{{ row.redeemedCount||row.redemptionCount||0 }}{{ row.maxRedemptions!=null?` / ${row.maxRedemptions}`:'' }} used</span><span class="ed-pill" :class="voucherState(row).tone">{{ voucherState(row).label }}</span><div class="ed-actions"><button v-if="codeFor(row)||shareTarget(row)" class="ed-btn compact" type="button" @click="copyText(codeFor(row)||shareTarget(row),'Code')"><Icon name="copy"/>Copy</button><button v-if="codeFor(row)||shareTarget(row)" class="ed-btn compact" type="button" @click="openShare(row)"><Icon name="qr"/>Share / QR</button><button v-else-if="canManage" class="ed-btn compact" type="button" @click="openReplacement(row)"><Icon name="spark"/>Replace securely</button><button v-if="canManage" class="ed-btn compact" type="button" @click="openVoucher(row)"><Icon name="edit"/>Manage</button></div></div>
      <div v-if="!vouchers.length" class="ed-empty"><p>No reusable code has been created.</p></div>
    </section>

    <Modal v-if="voucher" :title="voucher.id?'Manage reusable code':'Create reusable code'" :busy="busy" @close="voucher=null"><form id="marketing-voucher-form" class="ed-form-grid" @submit.prevent="saveVoucher"><label class="ed-field wide"><span>Campaign offer</span><select v-model="voucher.promotionId" required :disabled="!!voucher.id" @change="voucherOfferChanged"><option v-for="row in voucherOffers" :key="row.id" :value="row.id">{{ campaignLabel(row) }} · {{ row.name }} · version {{ row.version }}</option></select><small>The code is tied to this exact offer version and follows its campaign channels and schedule.</small></label><label v-if="!voucher.id" class="ed-field wide"><span>Reusable code</span><div class="mf-code-input"><input v-model.trim="voucher.code" type="text" minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="STUDENT" required><button class="ed-btn" type="button" @click="generateCode">Suggest code</button></div><small>Customers and staff can enter this same code at the storefront or POS. Use a memorable code such as STUDENT or STAFF that is safe to publish.</small></label><div v-else-if="voucher.displayCode" class="mf-code-card wide"><span>Reusable code</span><code>{{ voucher.displayCode }}</code><button class="ed-btn compact" type="button" @click="copyText(voucher.displayCode,'Code')"><Icon name="copy"/>Copy</button></div><div v-else class="ed-notice warning wide"><Icon name="shield"/><div><strong>{{ voucher.codeHint }}</strong>This legacy code cannot be revealed. Create a replacement if staff need to copy, share, or print it.</div></div><label class="ed-field"><span>Starts</span><input v-model="voucher.validFrom" type="datetime-local" required></label><label class="ed-field"><span>Ends · optional</span><input v-model="voucher.validUntil" type="datetime-local"></label><label class="ed-field"><span>Maximum uses · optional</span><input v-model="voucher.maxRedemptions" type="number" min="1" step="1"></label><label class="ed-field"><span>Per-customer limit · optional</span><input v-model="voucher.perCustomerLimit" type="number" min="1" step="1"></label><label class="mf-check wide"><input v-model="voucher.enabled" type="checkbox">Accept this code during the linked offer window</label></form><p v-if="localError||error" class="ed-notice error">{{ localError||error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="voucher=null">Cancel</button><button class="ed-btn primary" type="submit" form="marketing-voucher-form" :disabled="busy">{{ busy?'Saving…':voucher.id?'Save code':'Create code' }}</button></template></Modal>

    <Modal v-if="replacement" title="Replace legacy masked code" :busy="busy" @close="replacement=null"><div class="ed-notice warning"><Icon name="shield"/><div><strong>{{ replacement.codeHint }}</strong>The original code cannot be recovered. Replacing it disables that code and creates a new reusable code with the same limits and campaign link.</div></div><label class="ed-field"><span>New reusable code</span><div class="mf-code-input"><input v-model.trim="replacement.code" type="text" minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="STAFF" required><button class="ed-btn" type="button" @click="suggestReplacement">Suggest code</button></div></label><p v-if="localError||error" class="ed-notice error">{{ localError||error }}</p><template #actions><button class="ed-btn" :disabled="busy" @click="replacement=null">Cancel</button><button class="ed-btn primary" :disabled="busy||!replacement.code" @click="rotateVoucher">Replace &amp; show code</button></template></Modal>

    <Modal v-if="share" title="Share reusable promotion" @close="share=null;qrData='';notice='';localError=''">
      <div class="mf-share-code"><span>CODE</span><code>{{ codeFor(share)||share.codeHint }}</code><strong>{{ share.campaignName||campaignLabel(offerForVoucher(share)||{}) }}</strong></div>
      <img v-if="qrData" class="mf-promo-qr" :src="qrData" :alt="`QR code for ${codeFor(share)||'promotion'}`">
      <p v-else-if="shareBusy" class="mf-share-wait">Generating QR…</p>
      <div v-if="shareIsLink" class="ed-notice"><Icon name="link"/><div><strong>Storefront auto-apply link</strong><span class="mf-share-url">{{ shareTarget(share) }}</span></div></div>
      <p v-if="notice" class="ed-notice success" role="status">{{ notice }}</p><p v-if="localError" class="ed-notice error" role="alert">{{ localError }}</p>
      <template #actions><button v-if="codeFor(share)" class="ed-btn" @click="copyText(codeFor(share),'Code')"><Icon name="copy"/>Copy code</button><button v-if="shareIsLink" class="ed-btn" @click="copyText(shareTarget(share),'Link')"><Icon name="link"/>Copy link</button><a v-if="qrData" class="ed-btn primary" :href="qrData" :download="`${codeFor(share)||'promotion'}-qr.png`"><Icon name="download"/>Download QR</a></template>
    </Modal>
  </section>
</template>

<style scoped>
.mf-offers-panel{display:grid;gap:20px}.mf-offer-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.mf-offer-grid article,.ed-section{border:1px solid var(--ed-line);background:var(--ed-paper);padding:20px}.mf-offer-grid header{display:flex;justify-content:space-between}.mf-offer-grid h3{font:400 23px var(--ed-font-sans);margin:12px 0 7px}.mf-offer-grid>article>strong{color:var(--ed-accent)}.mf-offer-grid dl{margin:18px 0 0}.mf-offer-grid dl div{display:flex;justify-content:space-between;gap:15px;border-top:1px solid var(--ed-line);padding:9px 0;font-size:10px}.mf-offer-grid dt{color:var(--ed-muted)}.mf-offer-link{display:flex;justify-content:space-between;gap:8px;margin-top:14px;padding:7px 9px;background:var(--ed-wash);font-size:9px}.mf-offer-link small{color:var(--ed-muted)}.mf-offer-code-action{margin-top:13px;width:100%}.ed-section h3{font:400 23px var(--ed-font-sans);margin:0}.ed-row small{display:block;margin-top:4px}.ed-btn.compact{min-height:32px;padding:0 10px}.mf-check{display:flex;align-items:center;gap:8px;font-size:11px}.mf-code-row{align-items:center}.mf-code-main{display:grid;flex:1;gap:3px;min-width:190px}.mf-code-main code,.mf-code-card code,.mf-share-code code{font:700 18px var(--ed-font-mono);letter-spacing:.08em;color:var(--ed-accent)}.mf-legacy-note{color:var(--ed-danger,#a93226);font-size:9px;font-style:normal}.mf-code-input{display:flex;gap:8px}.mf-code-input input{flex:1;text-transform:uppercase}.mf-code-card{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;border:1px solid var(--ed-line);padding:14px}.mf-code-card>span{font-size:9px;color:var(--ed-muted);text-transform:uppercase}.mf-share-code{display:grid;justify-items:center;gap:7px;margin-bottom:15px}.mf-share-code>span{font-size:9px;letter-spacing:.12em;color:var(--ed-muted)}.mf-share-code code{font-size:28px}.mf-promo-qr{display:block;width:280px;max-width:100%;aspect-ratio:1;margin:0 auto 18px;border:1px solid var(--ed-line)}.mf-share-wait{text-align:center;color:var(--ed-muted)}.mf-share-url{display:block;overflow-wrap:anywhere;font-size:9px;margin-top:4px}@media(max-width:800px){.mf-offer-grid{grid-template-columns:1fr}.ed-row{align-items:flex-start;flex-wrap:wrap}.mf-code-input{align-items:stretch;flex-direction:column}.mf-code-card{grid-template-columns:1fr}.mf-code-row>.ed-actions{width:100%}}
</style>
