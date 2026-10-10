<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Store } from '../../store';
import { api } from '../../services/api';
import {
  MARKETING_TABS, audiencePayload, campaignToForm, loadMarketingWorkspace, marketingPaths,
  saveMarketingCampaign,
} from '../../domain/marketing.js';
import Icon from '../ui/EditionIcon.vue';
import CampaignWizard from './marketing/CampaignWizard.vue';
import MarketingAudiences from './marketing/MarketingAudiences.vue';
import MarketingCampaigns from './marketing/MarketingCampaigns.vue';
import MarketingEligibility from './marketing/MarketingEligibility.vue';
import MarketingLoyalty from './marketing/MarketingLoyalty.vue';
import MarketingOffers from './marketing/MarketingOffers.vue';
import MarketingOverview from './marketing/MarketingOverview.vue';

const route=useRoute(),router=useRouter();
const company=computed(()=>Store.state.selectedCompany||{});
const currency=computed(()=>company.value.preferences?.currency||'RM');
const workspace=ref({campaigns:[],audiences:[],offers:[],vouchers:[],eligibility:[],customers:[],analytics:{}});
const tab=ref('overview'),loading=ref(false),busy=ref(false),error=ref(''),wizard=ref(false),campaignAnalytics=ref(null),loyaltyEvents=ref([]);
let requestVersion=0,loyaltyRequestVersion=0;
const permissions=computed(()=>Store.permissions());
const canManage=computed(()=>Store.can('marketingManage'));
const canWorkspaceManage=computed(()=>Store.can('marketingWorkspaceManage'));
const canReviewEligibility=computed(()=>Store.can('studentEligibilityReview'));
const draftOffers=computed(()=>workspace.value.offers.filter(row=>!row.enabled));

function selectTab(value,{replace=false}={}){if(!MARKETING_TABS.some(item=>item.id===value))value='overview';tab.value=value;const location={path:'/marketing',query:value==='overview'?{}:{tab:value}};replace?router.replace(location):router.push(location);}
async function load(){const current=++requestVersion;if(!company.value.id)return;loading.value=true;error.value='';try{const result=await loadMarketingWorkspace(api,company.value.id);if(current===requestVersion)workspace.value=result;}catch(caught){if(current===requestVersion)error.value=caught.message||'Sales and marketing data could not be loaded.';}finally{if(current===requestVersion)loading.value=false;}}
async function loadLoyaltyEvents(){const companyId=company.value.id,current=++loyaltyRequestVersion;if(!companyId)return;try{const result=await api(`${marketingPaths(companyId).loyalty}/events?scope=company&limit=100`);if(current===loyaltyRequestVersion&&company.value.id===companyId)loyaltyEvents.value=result.rows||[];}catch(caught){if(current===loyaltyRequestVersion&&company.value.id===companyId&&caught.status!==404)error.value=caught.message||'Loyalty history could not be loaded.';}}
function openCampaign(row=null){wizard.value=row?campaignToForm(row,draftOffers.value,workspace.value.audiences):{};error.value='';}
async function saveCampaign({form,publish}){busy.value=true;error.value='';try{await saveMarketingCampaign(api,company.value.id,{...form,availableOffers:draftOffers.value,availableAudiences:workspace.value.audiences},{publish});wizard.value=false;Store.notify(publish?'Campaign published.':'Campaign draft saved.');await load();}catch(caught){error.value=caught.message||'Campaign could not be saved.';}finally{busy.value=false;}}
async function transition({campaign,action}){busy.value=true;error.value='';const past={publish:'published',pause:'paused',complete:'completed',archive:'archived'}[action]||action;try{await api(`${marketingPaths(company.value.id).campaigns}/${encodeURIComponent(campaign.id)}/${action}`,{method:'POST',body:{expectedVersion:Number(campaign.version)}});Store.notify(`Campaign ${past}.`);await load();}catch(caught){error.value=caught.message||`Campaign could not be ${past}.`;}finally{busy.value=false;}}
async function cloneCampaign(campaign){busy.value=true;error.value='';try{await api(`${marketingPaths(company.value.id).campaigns}/${encodeURIComponent(campaign.id)}/clone`,{method:'POST',body:{expectedVersion:Number(campaign.version),name:`${campaign.name} copy`}});Store.notify('Campaign cloned as a draft.');await load();}catch(caught){error.value=caught.message==='campaign_voucher_clone_requires_new_code'?'Voucher campaigns need a fresh bearer code. Create a new campaign and voucher instead.':caught.message||'Campaign could not be cloned.';}finally{busy.value=false;}}
const ymd=date=>{const year=date.getFullYear(),month=String(date.getMonth()+1).padStart(2,'0'),day=String(date.getDate()).padStart(2,'0');return `${year}-${month}-${day}`;};
async function openAnalytics(campaign){busy.value=true;error.value='';try{const to=new Date(),from=new Date(to);from.setDate(from.getDate()-29);const result=await api(`${marketingPaths(company.value.id).campaigns}/${encodeURIComponent(campaign.id)}/analytics?from=${ymd(from)}&to=${ymd(to)}`);campaignAnalytics.value={...result,campaignName:campaign.name};}catch(caught){error.value=caught.message||'Campaign analytics could not be loaded.';}finally{busy.value=false;}}
async function saveAudience({id,payload,done}){busy.value=true;error.value='';try{const path=id?`${marketingPaths(company.value.id).audiences}/${encodeURIComponent(id)}`:marketingPaths(company.value.id).audiences;await api(path,{method:id?'PUT':'POST',body:audiencePayload(payload,{workspace:payload.scope==='workspace'})});done?.();Store.notify('Audience version saved.');await load();}catch(caught){error.value=caught.message||'Audience could not be saved.';}finally{busy.value=false;}}
async function saveEligibility({customerId,payload,done}){busy.value=true;error.value='';try{await api(`/companies/${encodeURIComponent(company.value.id)}/student-eligibilities/${encodeURIComponent(customerId)}`,{method:'PUT',body:payload});done?.();Store.notify('Eligibility review saved.');await load();}catch(caught){error.value=caught.message||'Eligibility review could not be saved.';}finally{busy.value=false;}}
async function saveVoucher({promotionId,payload,done}){busy.value=true;error.value='';try{await api(`/companies/${encodeURIComponent(company.value.id)}/student-promotions/${encodeURIComponent(promotionId)}/vouchers`,{method:'POST',body:payload});done?.();Store.notify('Voucher created.');await load();}catch(caught){error.value=caught.message||'Voucher could not be created.';}finally{busy.value=false;}}
async function saveLoyaltySettings(payload){busy.value=true;error.value='';try{workspace.value.loyalty=await api(marketingPaths(company.value.id).loyalty,{method:'PUT',body:payload});Store.notify('Loyalty settings saved.');}catch(caught){error.value=caught.message||'Loyalty settings could not be saved.';}finally{busy.value=false;}}
async function postLoyaltyEvent({kind,payload,done}){busy.value=true;error.value='';try{const suffix=kind==='redeem'?'/redemptions':'/adjustments';await api(`${marketingPaths(company.value.id).loyalty}${suffix}`,{method:'POST',body:payload});done?.();Store.notify(kind==='redeem'?'Points redeemed.':'Point adjustment recorded.');await Promise.all([load(),loadLoyaltyEvents()]);}catch(caught){error.value=caught.message||'Loyalty event could not be recorded.';}finally{busy.value=false;}}
async function reverseLoyalty({eventId,payload,done}){busy.value=true;error.value='';try{await api(`${marketingPaths(company.value.id).loyalty}/events/${encodeURIComponent(eventId)}/reverse`,{method:'POST',body:payload});done?.();Store.notify('Loyalty event reversed.');await Promise.all([load(),loadLoyaltyEvents()]);}catch(caught){error.value=caught.message||'Loyalty event could not be reversed.';}finally{busy.value=false;}}

watch(()=>route.query.tab,value=>{const next=String(value||'overview');tab.value=MARKETING_TABS.some(item=>item.id===next)?next:'overview';},{immediate:true});
watch(()=>company.value.id,()=>{loyaltyRequestVersion++;workspace.value={campaigns:[],audiences:[],offers:[],vouchers:[],eligibility:[],customers:[],analytics:{}};loyaltyEvents.value=[];load();},{immediate:true});
watch([tab,()=>company.value.id],([value,companyId])=>{if(value==='loyalty'&&companyId)loadLoyaltyEvents();},{immediate:true});
</script>

<template>
  <section class="ed-page mf-marketing-hub">
    <header class="ed-page-head"><div><div class="ed-eyebrow">GROWTH / SALES & MARKETING</div><h1>Turn offers into learning.</h1><p>Plan campaigns, define audiences, reward loyalty and read attributed outcomes for {{ company.name }}.</p></div><div class="ed-actions"><button class="ed-btn" :disabled="loading" @click="load"><Icon name="clock"/>{{ loading?'Loading…':'Refresh' }}</button><button v-if="canManage" class="ed-btn primary" :disabled="!Store.state.online" @click="openCampaign()"><Icon name="plus"/>New campaign</button></div></header>
    <div class="ed-notice"><Icon name="shield"/><div><strong>{{ permissions.owner?'Workspace marketing view':'Company marketing view' }}</strong>{{ permissions.owner?'Workspace owners can define shared audiences and loyalty rules. Campaigns and their attributed results remain tied to the selected company.':'Managers can run campaigns and company audiences here. Workspace-wide rules remain owner controlled.' }}</div></div>
    <p v-if="error&&wizard===false&&!campaignAnalytics" class="ed-notice error" role="alert">{{ error }}</p>
    <nav class="ed-tabs mf-marketing-tabs" aria-label="Sales and marketing sections"><button v-for="item in MARKETING_TABS" :key="item.id" role="tab" :aria-selected="tab===item.id" :class="{active:tab===item.id}" @click="selectTab(item.id)">{{ item.label }}<span v-if="item.id==='campaigns'">{{ workspace.campaigns.length }}</span></button></nav>
    <div v-if="loading&&!workspace.campaigns.length" class="ed-empty" role="status"><span class="spinner"></span><h3>Loading sales and marketing…</h3></div>
    <template v-else>
      <MarketingOverview v-if="tab==='overview'" :workspace="workspace" :currency="currency" :can-manage="canManage" @new-campaign="openCampaign()" @open-campaign="openAnalytics" @open-tab="selectTab"/>
      <MarketingCampaigns v-else-if="tab==='campaigns'" :campaigns="workspace.campaigns" :analytics="campaignAnalytics" :currency="currency" :can-manage="canManage" :busy="busy" :error="error" @new="openCampaign()" @edit="openCampaign" @transition="transition" @clone="cloneCampaign" @analytics="openAnalytics" @close-analytics="campaignAnalytics=null;error=''"/>
      <MarketingOffers v-else-if="tab==='offers'" :offers="workspace.offers" :vouchers="workspace.vouchers" :products="Store.state.products" :currency="currency" :can-manage="canManage" :busy="busy" :error="error" @new-campaign="openCampaign()" @save-voucher="saveVoucher"/>
      <MarketingLoyalty v-else-if="tab==='loyalty'" :loyalty="workspace.loyalty" :events="loyaltyEvents" :customers="workspace.customers" :currency="currency" :can-configure="canWorkspaceManage" :can-adjust="canManage" :busy="busy" :error="error" @save-settings="saveLoyaltySettings" @post-event="postLoyaltyEvent" @reverse="reverseLoyalty" @refresh-events="loadLoyaltyEvents"/>
      <MarketingAudiences v-else-if="tab==='audiences'" :audiences="workspace.audiences" :customers="workspace.customers" :can-manage="canManage" :can-workspace-manage="canWorkspaceManage" :busy="busy" :error="error" @save="saveAudience"/>
      <MarketingEligibility v-else :rows="workspace.eligibility" :can-review="canReviewEligibility" :busy="busy" :error="error" @save="saveEligibility"/>
    </template>
    <CampaignWizard v-if="wizard!==false" :campaign="wizard" :audiences="workspace.audiences" :offers="draftOffers" :products="Store.state.products" :busy="busy" :error="error" :can-publish="canManage" @close="wizard=false;error=''" @save="saveCampaign"/>
  </section>
</template>

<style scoped>
.mf-marketing-hub{max-width:1500px}.mf-marketing-tabs{margin:24px 0}.mf-marketing-tabs button{display:flex;align-items:center;gap:7px}.mf-marketing-tabs button span{display:grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:var(--ed-wash);font-size:8px}.mf-marketing-tabs button.active span{background:#ffffff25}.spinner{width:28px;height:28px;border:3px solid var(--ed-line);border-top-color:var(--ed-accent);border-radius:50%;animation:mf-spin .7s linear infinite}@keyframes mf-spin{to{transform:rotate(360deg)}}@media(max-width:900px){.mf-marketing-tabs{overflow:auto}.mf-marketing-tabs button{white-space:nowrap}}
</style>
