<script setup>
import { computed, ref, watch } from 'vue';
import {
  CAMPAIGN_GOALS, MARKETING_CHANNELS, OFFER_TYPES, campaignStepError, emptyCampaign,
  selectedProduct,
} from '../../../domain/marketing.js';
import Icon from '../../ui/EditionIcon.vue';
import Modal from '../../ui/EditionModal.vue';

const props = defineProps({
  campaign:{type:Object,default:null}, audiences:{type:Array,default:()=>[]},
  offers:{type:Array,default:()=>[]}, products:{type:Array,default:()=>[]},
  busy:Boolean, error:{type:String,default:''}, canPublish:{type:Boolean,default:true},
});
const emit = defineEmits(['close','save']);
const steps = ['Goal','Audience','Offer','Channel','Schedule & limits','Review'];
const step = ref(0), localError = ref('');
const targetQuery = ref('');
const copy = value => JSON.parse(JSON.stringify(value));
const form = ref({ ...emptyCampaign(), ...(props.campaign ? copy(props.campaign) : {}) });

watch(() => props.campaign, value => {
  form.value = { ...emptyCampaign(), ...(value ? copy(value) : {}) };
  step.value = 0; localError.value = '';
});

const availableAudiences = computed(() => [
  { id:'', name:'Everyone', description:'No audience restriction. Every qualified customer can receive the offer.', estimatedSize:null },
  ...props.audiences,
]);
const selectedAudience = computed(() => availableAudiences.value.find(row => row.id === form.value.audienceId) || availableAudiences.value[0]);
const selectedReward = computed(() => selectedProduct(props.products, form.value.rewardProductId, form.value.rewardVariantId));
const selectedOfferLabel = computed(() => OFFER_TYPES.find(row => row.id === form.value.offerType)?.label || 'Offer');
const activeProduct = computed(() => props.products.find(row => row.id === form.value.rewardProductId));
const targetProducts = computed(() => {
  const needle=targetQuery.value.trim().toLocaleLowerCase();
  return props.products.flatMap(product => [
    {key:JSON.stringify([product.id,'']),label:product.name,detail:`${product.sku || 'Product'} · all options`,productId:product.id,variantId:''},
    ...(product.variants || []).map(variant => ({key:JSON.stringify([product.id,variant.id]),label:`${product.name} · ${variant.name}`,detail:variant.sku || 'Product option',productId:product.id,variantId:variant.id})),
  ]).filter(row=>!needle||`${row.label} ${row.detail}`.toLocaleLowerCase().includes(needle)).slice(0,60);
});
const targetCategories = computed(() => {
  const rows=new Map();
  for(const product of props.products){const category=String(product.category||'').trim().toLocaleLowerCase(),subcategory=String(product.subcategory||'').trim().toLocaleLowerCase();if(!category)continue;const parent=JSON.stringify([category,'']);rows.set(parent,{key:parent,label:product.category,category,subcategory:''});if(subcategory){const child=JSON.stringify([category,subcategory]);rows.set(child,{key:child,label:`${product.category} / ${product.subcategory}`,category,subcategory});}}
  return [...rows.values()].sort((a,b)=>a.label.localeCompare(b.label));
});
const dateLabel = value => value ? new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value)) : 'No expiry';

function next() {
  const issue = campaignStepError(step.value, form.value, {
    audiences:props.audiences, offers:props.offers, products:props.products,
  });
  if (issue) { localError.value = issue; return; }
  localError.value = ''; step.value = Math.min(steps.length - 1, step.value + 1);
}
function back() { localError.value = ''; step.value = Math.max(0, step.value - 1); }
function chooseOffer(type) {
  form.value.offerChanged = true;
  form.value.offerType = type;
  if (type === 'percentage' && !form.value.offerValue) form.value.offerValue = '10';
  if (type === 'fixed') form.value.offerValue = '5.00';
  if (type === 'bonus_points') {
    form.value.offerValue = '100';
    form.value.maxRedemptions = '';
    form.value.perCustomerLimit = '';
  }
}
function touchOffer() {
  if (form.value.offerType === 'bonus_points') return;
  form.value.offerMode = 'new';
  form.value.offerChanged = true;
}
function toggleTarget(field, option) {
  const values=new Set(form.value[field] || []), adding=!values.has(option.key);
  adding ? values.add(option.key) : values.delete(option.key);
  if(adding){for(const key of [...values]){if(key===option.key)continue;try{const [parent,child]=JSON.parse(key);if(parent===(option.productId||option.category)&&(!child||!(option.variantId||option.subcategory)))values.delete(key);}catch{}}}
  form.value[field]=[...values];touchOffer();
}
function toggleChannel(channel) {
  const selected = new Set(form.value.channels || []);
  selected.has(channel) ? selected.delete(channel) : selected.add(channel);
  form.value.channels = [...selected];
}
function submit(publish) {
  if (publish && !form.value.channels.includes('storefront')) {
    step.value=3;
    localError.value='Add Online storefront before publishing. POS and messaging channels are planning touchpoints in this release.';
    return;
  }
  for (let index=0; index<5; index++) {
    const issue = campaignStepError(index, form.value, {
      audiences:props.audiences, offers:props.offers, products:props.products,
    });
    if (issue) { step.value=index; localError.value=issue; return; }
  }
  localError.value=''; emit('save',{ form:copy(form.value), publish });
}
</script>

<template>
  <Modal title="Campaign builder" wide :busy="busy" @close="emit('close')">
    <div class="mf-wizard">
      <nav class="mf-wizard-steps" aria-label="Campaign steps">
        <button v-for="(label,index) in steps" :key="label" type="button" :class="{active:index===step,done:index<step}" :aria-current="index===step?'step':undefined" @click="index<step&&(step=index)"><span>{{ index+1 }}</span>{{ label }}</button>
      </nav>

      <section v-if="step===0" class="mf-wizard-panel" aria-labelledby="campaign-goal-title">
        <div><div class="ed-eyebrow">STEP 1 / GOAL</div><h2 id="campaign-goal-title">What should this campaign achieve?</h2><p>A goal gives the team one shared reason for the offer. Results remain attributed evidence, not proof of causation.</p></div>
        <label class="ed-field"><span>Campaign name</span><input v-model.trim="form.name" maxlength="160" autofocus placeholder="October return visit"></label>
        <div class="mf-choice-grid"><button v-for="goal in CAMPAIGN_GOALS" :key="goal.id" type="button" :class="{selected:form.goal===goal.id}" @click="form.goal=goal.id"><Icon :name="goal.id==='inventory_clearance'?'box':'chart'"/><span><strong>{{ goal.label }}</strong><small>{{ goal.description }}</small></span></button></div>
      </section>

      <section v-else-if="step===1" class="mf-wizard-panel" aria-labelledby="campaign-audience-title">
        <div><div class="ed-eyebrow">STEP 2 / AUDIENCE</div><h2 id="campaign-audience-title">Choose who can qualify.</h2><p>Audience rules are evaluated by the server. Contact channels still require the customer’s matching consent.</p></div>
        <div class="mf-audience-picker"><label v-for="audience in availableAudiences" :key="audience.id||'everyone'" :class="{selected:form.audienceId===audience.id}"><input v-model="form.audienceId" type="radio" :value="audience.id"><span><strong>{{ audience.name }}</strong><small>{{ audience.description || 'Saved audience' }}</small></span><em v-if="audience.estimatedSize!=null">{{ audience.estimatedSize }} people</em></label></div>
        <p v-if="!props.audiences.length" class="ed-notice"><Icon name="people"/><span><strong>No saved audience yet</strong>Use Everyone for this campaign, or create a reusable audience from the Audiences tab.</span></p>
      </section>

      <section v-else-if="step===2" class="mf-wizard-panel" aria-labelledby="campaign-offer-title">
        <div><div class="ed-eyebrow">STEP 3 / OFFER</div><h2 id="campaign-offer-title">Give customers a clear reason to act.</h2><p>The offer becomes a versioned pricing or loyalty rule and is linked to this campaign for attribution.</p></div>
        <div class="mf-mode-switch"><button type="button" :class="{active:form.offerMode!=='existing'}" @click="form.offerMode='new';form.offerChanged=true">Build an offer</button><button type="button" :class="{active:form.offerMode==='existing'}" :disabled="!offers.length" @click="form.offerMode='existing';form.offerChanged=false">Use existing version</button></div>
        <label v-if="form.offerMode==='existing'" class="ed-field"><span>Available immutable offer</span><select v-model="form.existingPromotionKey"><option value="" disabled>Select an offer</option><option v-for="offer in offers" :key="`${offer.id}:${offer.version}`" :value="`${offer.id}:${offer.version}`">{{ offer.name }} · version {{ offer.version }} · {{ offer.discountType?.replace('_',' ') }}</option></select><small>The campaign keeps this exact version for attribution. Publishing creates and links the active version atomically.</small></label>
        <template v-else><div class="mf-offer-types"><button v-for="offer in OFFER_TYPES" :key="offer.id" type="button" :class="{selected:form.offerType===offer.id}" @click="chooseOffer(offer.id)"><Icon :name="offer.id==='free_item'?'bag':offer.id==='bonus_points'?'spark':'percent'"/><strong>{{ offer.label }}</strong></button></div>
        <div class="ed-form-grid">
          <label v-if="form.offerType!=='bonus_points'" class="ed-field wide"><span>How customers redeem it</span><select v-model="form.redemptionMode" @change="touchOffer"><option value="automatic">Automatic storefront pricing</option><option value="voucher">Voucher code</option></select><small v-if="form.redemptionMode==='voucher'">Save the campaign draft, then create its secure code from Offers &amp; vouchers before publishing.</small></label>
          <label v-if="['percentage','fixed','bonus_points'].includes(form.offerType)" class="ed-field"><span>{{ form.offerType==='percentage'?'Discount percentage':form.offerType==='fixed'?'Discount amount (RM)':'Bonus points' }}</span><input v-model="form.offerValue" :inputmode="form.offerType==='bonus_points'?'numeric':'decimal'" :placeholder="form.offerType==='percentage'?'10':form.offerType==='fixed'?'5.00':'100'" @input="form.offerChanged=true"></label>
          <template v-else><label class="ed-field wide"><span>Free product</span><select v-model="form.rewardProductId" required @change="form.rewardVariantId='';form.offerChanged=true"><option value="" disabled>Select a product</option><option v-for="product in products" :key="product.id" :value="product.id">{{ product.name }} · {{ product.sku }}</option></select></label><label v-if="activeProduct?.variants?.length" class="ed-field wide"><span>Exact product option</span><select v-model="form.rewardVariantId" required @change="form.offerChanged=true"><option value="" disabled>Select an option</option><option v-for="variant in activeProduct.variants" :key="variant.id" :value="variant.id">{{ variant.name }} · {{ variant.sku }}</option></select><small>Free-item pricing must identify the exact sellable option so stock and order evidence stay consistent.</small></label></template>
          <label class="ed-field"><span>Minimum qualifying spend (RM)</span><input v-model="form.minimumSpend" inputmode="decimal" placeholder="0.00" @input="touchOffer"></label>
          <label v-if="['percentage','fixed'].includes(form.offerType)" class="ed-field"><span>Maximum discount (RM) · optional</span><input v-model="form.maxDiscount" inputmode="decimal" placeholder="No cap" @input="touchOffer"></label>
        </div><details v-if="form.offerType!=='bonus_points'" class="mf-target-builder"><summary>Limit the offer to products or categories <span>{{ (form.targetProductKeys?.length||0)+(form.targetCategoryKeys?.length||0) || 'All products' }}</span></summary><p>Leave every option clear to apply the offer across the eligible basket.</p><label class="ed-field"><span>Find a product</span><input v-model="targetQuery" placeholder="Product, option or SKU"></label><div class="mf-target-columns"><fieldset><legend>Products</legend><label v-for="row in targetProducts" :key="row.key"><input type="checkbox" :checked="form.targetProductKeys?.includes(row.key)" @change="toggleTarget('targetProductKeys',row)"><span><strong>{{ row.label }}</strong><small>{{ row.detail }}</small></span></label><small v-if="!targetProducts.length">No product matches.</small></fieldset><fieldset><legend>Categories</legend><label v-for="row in targetCategories" :key="row.key"><input type="checkbox" :checked="form.targetCategoryKeys?.includes(row.key)" @change="toggleTarget('targetCategoryKeys',row)"><span><strong>{{ row.label }}</strong></span></label><small v-if="!targetCategories.length">No inventory category is available.</small></fieldset></div></details></template>
      </section>

      <section v-else-if="step===3" class="mf-wizard-panel" aria-labelledby="campaign-channel-title">
        <div><div class="ed-eyebrow">STEP 4 / CHANNEL</div><h2 id="campaign-channel-title">Where will customers encounter it?</h2><p>Storefront pricing is live. POS and email record planned campaign touchpoints in this release.</p></div>
        <div class="mf-channel-picker"><button v-for="channel in MARKETING_CHANNELS" :key="channel.id" type="button" :class="{selected:form.channels.includes(channel.id)}" @click="toggleChannel(channel.id)"><Icon :name="channel.id==='email'?'mail':channel.id==='pos'?'bag':'grid'"/><span><strong>{{ channel.label }}</strong><small>{{ channel.id==='email'?'Consent-aware campaign planning; no outbound email sender is configured yet.':channel.id==='pos'?'POS attribution touchpoint; automatic staff-checkout discounts are not enabled yet.':'Live automatic pricing for eligible online-order quotes.' }}</small></span><Icon :name="form.channels.includes(channel.id)?'check':'plus'"/></button></div>
        <div v-if="!form.channels.includes('storefront')" class="ed-notice warning"><Icon name="alert"/><div><strong>Draft planning only</strong>Add Online storefront before publishing. POS and messaging selections alone neither change customer prices nor award bonus points in this release.</div></div>
      </section>

      <section v-else-if="step===4" class="mf-wizard-panel" aria-labelledby="campaign-schedule-title">
        <div><div class="ed-eyebrow">STEP 5 / SCHEDULE & LIMITS</div><h2 id="campaign-schedule-title">Control when it runs and how far it can go.</h2><p>Limits protect stock and margin. Campaign budget is a monitoring ceiling; redemptions remain the transactional control.</p></div>
        <div class="ed-form-grid">
          <label class="ed-field"><span>Starts</span><input v-model="form.startsAt" type="datetime-local" @change="touchOffer"></label><label class="ed-field"><span>Ends · optional</span><input v-model="form.endsAt" type="datetime-local" @change="touchOffer"></label>
          <label class="ed-field"><span>Campaign budget (RM) · optional</span><input v-model="form.budget" inputmode="decimal" placeholder="No monitoring ceiling"></label><label v-if="form.offerType!=='bonus_points'" class="ed-field"><span>Maximum redemptions · optional</span><input v-model="form.maxRedemptions" type="number" min="1" step="1" placeholder="Unlimited" @input="touchOffer"></label>
          <label v-if="form.offerType!=='bonus_points'" class="ed-field"><span>Per-customer limit · optional</span><input v-model="form.perCustomerLimit" type="number" min="1" step="1" placeholder="Unlimited" @input="touchOffer"></label>
          <div v-else class="ed-notice wide"><Icon name="info"/><div><strong>Bonus award scope</strong>Every eligible paid storefront order earns the configured bonus. Total and per-customer point caps are not available in this release.</div></div>
        </div>
      </section>

      <section v-else class="mf-wizard-panel" aria-labelledby="campaign-review-title">
        <div><div class="ed-eyebrow">STEP 6 / REVIEW</div><h2 id="campaign-review-title">Review the customer promise.</h2><p>Save a draft for another review, or publish to let the schedule control when the linked offer becomes available.</p></div>
        <dl class="mf-review-grid">
          <div><dt>Campaign</dt><dd>{{ form.name }}</dd><small>{{ CAMPAIGN_GOALS.find(row=>row.id===form.goal)?.label }}</small></div>
          <div><dt>Audience</dt><dd>{{ selectedAudience?.name }}</dd><small>{{ selectedAudience?.description }}</small></div>
          <div><dt>Offer</dt><dd>{{ form.offerMode==='existing'?'Existing offer version':selectedOfferLabel }}</dd><small v-if="form.offerMode==='existing'">{{ offers.find(row=>`${row.id}:${row.version}`===form.existingPromotionKey)?.name }}</small><small v-else-if="form.offerType==='percentage'">{{ form.offerValue }}% discount · {{ form.redemptionMode==='voucher'?'voucher':'automatic storefront' }}</small><small v-else-if="form.offerType==='fixed'">RM {{ form.offerValue }} discount · {{ form.redemptionMode==='voucher'?'voucher':'automatic storefront' }}</small><small v-else-if="form.offerType==='bonus_points'">{{ form.offerValue }} bonus points</small><small v-else>{{ selectedReward?.label }} · {{ form.redemptionMode==='voucher'?'voucher':'automatic storefront' }}</small></div>
          <div><dt>Channels</dt><dd>{{ form.channels.map(id=>MARKETING_CHANNELS.find(row=>row.id===id)?.label).join(', ') }}</dd></div>
          <div><dt>Offer scope</dt><dd>{{ (form.targetProductKeys?.length||0)+(form.targetCategoryKeys?.length||0) ? `${form.targetProductKeys?.length||0} product · ${form.targetCategoryKeys?.length||0} category` : 'All eligible products' }}</dd></div>
          <div><dt>Schedule</dt><dd>{{ dateLabel(form.startsAt) }}</dd><small>to {{ dateLabel(form.endsAt) }}</small></div>
          <div><dt>Limits</dt><template v-if="form.offerType==='bonus_points'"><dd>No point-award cap</dd><small>Each eligible paid storefront order earns the bonus.</small></template><template v-else><dd>{{ form.maxRedemptions?`${form.maxRedemptions} total`:'No redemption cap' }}</dd><small>{{ form.perCustomerLimit?`${form.perCustomerLimit} per customer`:'No customer cap' }}</small></template></div>
        </dl>
        <div class="ed-notice warning"><Icon name="alert"/><div><strong>Attributed reporting is observational</strong>Conversions and revenue are counted when the order carries this campaign or linked-offer evidence. They are not causal ROI.</div></div>
        <div v-if="form.audienceId" class="ed-notice"><Icon name="shield"/><div><strong>Exact audience version</strong>Pricing and loyalty evaluate the linked audience version when a customer qualifies, preserving this campaign’s historical rules.</div></div>
      </section>

      <p v-if="localError||error" class="ed-notice error" role="alert">{{ localError||error }}</p>
    </div>
    <template #actions><button class="ed-btn" :disabled="busy" @click="step?back():emit('close')">{{ step?'Back':'Cancel' }}</button><button v-if="step<steps.length-1" class="ed-btn primary" :disabled="busy" @click="next">Continue</button><template v-else><button class="ed-btn" :disabled="busy" @click="submit(false)">{{ busy?'Saving…':'Save draft' }}</button><button v-if="canPublish" class="ed-btn primary" :disabled="busy" @click="submit(true)">{{ busy?'Publishing…':'Publish campaign' }}</button></template></template>
  </Modal>
</template>

<style scoped>
.mf-wizard{display:grid;gap:25px}.mf-wizard-steps{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--ed-line)}.mf-wizard-steps button{display:flex;align-items:center;justify-content:center;gap:7px;border:0;border-right:1px solid var(--ed-line);background:var(--ed-paper);padding:11px 5px;color:var(--ed-muted);font-size:9px}.mf-wizard-steps button:last-child{border-right:0}.mf-wizard-steps span{display:grid;place-items:center;width:19px;height:19px;border:1px solid var(--ed-line);border-radius:50%}.mf-wizard-steps .active{background:var(--ed-accent);color:white}.mf-wizard-steps .done{color:var(--ed-accent);background:var(--ed-wash)}.mf-wizard-panel{display:grid;gap:22px;min-height:360px}.mf-wizard-panel h2{font:400 31px var(--ed-font-sans);margin:8px 0}.mf-wizard-panel>div>p{color:var(--ed-muted);font-size:12px;max-width:700px}.mf-choice-grid,.mf-offer-types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mf-choice-grid button,.mf-offer-types button,.mf-channel-picker button{display:flex;align-items:flex-start;gap:12px;text-align:left;border:1px solid var(--ed-line);background:var(--ed-paper);padding:16px;color:var(--ed-ink)}.mf-choice-grid button.selected,.mf-offer-types button.selected,.mf-channel-picker button.selected,.mf-audience-picker label.selected{border-color:var(--ed-accent);box-shadow:inset 3px 0 var(--ed-accent);background:var(--ed-wash)}.mf-choice-grid span,.mf-channel-picker span{display:grid;gap:5px;flex:1}.mf-choice-grid small,.mf-channel-picker small,.mf-audience-picker small,.mf-review-grid small{color:var(--ed-muted);font-size:10px;line-height:1.4}.mf-audience-picker,.mf-channel-picker{display:grid;gap:9px}.mf-audience-picker label{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;border:1px solid var(--ed-line);padding:15px}.mf-audience-picker span{display:grid;gap:4px}.mf-audience-picker em{font-size:10px;color:var(--ed-muted);font-style:normal}.mf-review-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0}.mf-review-grid div{border:1px solid var(--ed-line);padding:15px;display:grid;gap:6px}.mf-review-grid dt{font-size:9px;letter-spacing:.1em;color:var(--ed-muted);text-transform:uppercase}.mf-review-grid dd{font:400 19px var(--ed-font-sans);margin:0}.mf-offer-types{grid-template-columns:repeat(4,minmax(0,1fr))}.mf-offer-types button{align-items:center;flex-direction:column}.mf-channel-picker button>.ed-icon:last-child{margin-left:auto}@media(max-width:800px){.mf-wizard-steps{grid-template-columns:repeat(3,1fr)}.mf-wizard-steps button:nth-child(3){border-right:0}.mf-wizard-steps button:nth-child(-n+3){border-bottom:1px solid var(--ed-line)}.mf-choice-grid,.mf-offer-types,.mf-review-grid{grid-template-columns:1fr}.mf-wizard-steps button{font-size:0}.mf-wizard-steps button span{font-size:9px}}
.mf-mode-switch{display:flex;border-bottom:1px solid var(--ed-line)}.mf-mode-switch button{border:0;border-bottom:2px solid transparent;background:none;padding:10px 15px;color:var(--ed-muted);font-size:11px}.mf-mode-switch button.active{border-color:var(--ed-accent);color:var(--ed-ink);font-weight:700}.mf-mode-switch button:disabled{opacity:.45}
.mf-target-builder{border:1px solid var(--ed-line);padding:14px}.mf-target-builder summary{cursor:pointer;font-size:11px;font-weight:700}.mf-target-builder summary span{float:right;color:var(--ed-accent)}.mf-target-builder>p{color:var(--ed-muted);font-size:10px}.mf-target-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mf-target-columns fieldset{border:1px solid var(--ed-line);max-height:240px;overflow:auto;padding:11px}.mf-target-columns legend{font-size:9px;text-transform:uppercase;letter-spacing:.08em}.mf-target-columns label{display:flex;align-items:flex-start;gap:8px;padding:7px 2px;border-bottom:1px solid var(--ed-line);font-size:10px}.mf-target-columns label>span{display:grid;gap:3px}.mf-target-columns small{color:var(--ed-muted);font-size:9px}@media(max-width:700px){.mf-target-columns{grid-template-columns:1fr}}
</style>
