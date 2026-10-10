<script setup>
import { computed } from 'vue';
import { ATTRIBUTION_NOTICE, attributedMetricCards, campaignLifecycleLabel } from '../../../domain/marketing.js';
import Icon from '../../ui/EditionIcon.vue';

const props=defineProps({workspace:{type:Object,required:true},currency:{type:String,default:'RM'},canManage:Boolean});
const emit=defineEmits(['new-campaign','open-campaign','open-tab']);
const cards=computed(()=>attributedMetricCards(props.workspace.analytics,props.currency,props.workspace.customerCohort));
const live=computed(()=>props.workspace.campaigns.filter(row=>['active','scheduled'].includes(row.status)).slice(0,5));
const funnel=computed(()=>{const quotes=props.workspace.analytics.qualifiedQuotes,conversions=props.workspace.analytics.conversions;return quotes?Math.min(100,Math.round(Number(conversions||0)*100/Number(quotes))):null;});
const money=sen=>`${props.currency} ${(Number(sen||0)/100).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
</script>

<template>
  <section class="mf-marketing-overview">
    <div class="mf-marketing-kpis"><article v-for="card in cards" :key="card.key"><span>{{ card.label }}</span><strong>{{ card.value }}</strong></article></div>
    <div class="ed-notice"><Icon name="chart"/><div><strong>Attributed performance</strong>{{ ATTRIBUTION_NOTICE }}</div></div>
    <div class="mf-overview-grid">
      <section class="ed-section">
        <div class="ed-section-head"><div><div class="ed-eyebrow">CAMPAIGN PULSE</div><h2>What is running now</h2><small>Scheduled and live activity for this company.</small></div><button v-if="canManage" class="ed-btn primary" @click="emit('new-campaign')"><Icon name="plus"/>New campaign</button></div>
        <button v-for="campaign in live" :key="campaign.id" class="mf-campaign-row" @click="emit('open-campaign',campaign)"><span class="mf-state-dot" :class="campaign.status"></span><span><strong>{{ campaign.name }}</strong><small>{{ campaignLifecycleLabel(campaign.status) }} · {{ (campaign.objective||campaign.goal).replaceAll('_',' ') }}</small></span><span><strong>{{ campaign.promotionLinks?.length||0 }}</strong><small>offer links</small></span><span><strong>{{ campaign.audienceLinks?.length||0 }}</strong><small>audience links</small></span><Icon name="arrow"/></button>
        <div v-if="!live.length" class="ed-empty"><Icon name="spark"/><h3>No live campaign.</h3><p>Create a draft, review the audience and limits, then publish when it is ready.</p></div>
      </section>
      <aside class="ed-section mf-funnel-card"><div class="ed-eyebrow">ATTRIBUTED FUNNEL</div><h2>{{ funnel==null?'—':`${funnel}%` }}</h2><p>{{ funnel==null?'Open a campaign’s results to inspect its exact reporting window.':'of qualified quotes became attributed conversions in the selected reporting window.' }}</p><div class="mf-funnel-track"><i :style="{width:`${funnel||0}%`}"></i></div><dl><div><dt>Qualified quotes</dt><dd>{{ workspace.analytics.qualifiedQuotes??'—' }}</dd></div><div><dt>Conversions</dt><dd>{{ workspace.analytics.conversions??'—' }}</dd></div><div><dt>Discount cost</dt><dd>{{ workspace.analytics.discountCostSen==null?'—':money(workspace.analytics.discountCostSen) }}</dd></div></dl></aside>
    </div>
    <section class="ed-section"><div class="ed-section-head"><div><div class="ed-eyebrow">NEXT MOVES</div><h2>Build from customer evidence</h2></div></div><div class="mf-next-grid"><button @click="emit('open-tab','audiences')"><Icon name="people"/><strong>Define an audience</strong><small>Save consent and behaviour rules for repeated use.</small></button><button @click="emit('open-tab','offers')"><Icon name="percent"/><strong>Prepare an offer</strong><small>Review discounts, free items and voucher limits.</small></button><button @click="emit('open-tab','loyalty')"><Icon name="spark"/><strong>Shape loyalty</strong><small>Set earning and rewards, then inspect the ledger.</small></button></div></section>
  </section>
</template>

<style scoped>
.mf-marketing-overview{display:grid;gap:20px}.mf-marketing-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--ed-line);background:var(--ed-paper)}.mf-marketing-kpis article{padding:19px;border-right:1px solid var(--ed-line);display:grid;gap:8px}.mf-marketing-kpis article:nth-child(4n){border-right:0}.mf-marketing-kpis span,.mf-campaign-row small{font-size:9px;color:var(--ed-muted);text-transform:uppercase;letter-spacing:.07em}.mf-marketing-kpis strong{font:400 24px Georgia,serif}.mf-overview-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:20px}.ed-section{border:1px solid var(--ed-line);padding:22px;background:var(--ed-paper)}.mf-campaign-row{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr) minmax(90px,auto) minmax(120px,auto) auto;align-items:center;gap:13px;border:0;border-top:1px solid var(--ed-line);background:none;color:var(--ed-ink);padding:15px 2px;text-align:left}.mf-campaign-row>span{display:grid;gap:4px}.mf-state-dot{width:9px;height:9px!important;border-radius:50%;background:#999}.mf-state-dot.active{background:#219761}.mf-state-dot.scheduled{background:#d49b2f}.mf-funnel-card h2{font:400 48px Georgia,serif;margin:13px 0 3px}.mf-funnel-card p{font-size:11px;color:var(--ed-muted);line-height:1.5}.mf-funnel-track{height:8px;background:var(--ed-wash);margin:20px 0}.mf-funnel-track i{display:block;height:100%;background:var(--ed-accent)}.mf-funnel-card dl{margin:0}.mf-funnel-card dl div{display:flex;justify-content:space-between;border-top:1px solid var(--ed-line);padding:11px 0;font-size:11px}.mf-funnel-card dd{font-weight:700}.mf-next-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.mf-next-grid button{border:1px solid var(--ed-line);background:var(--ed-paper);padding:18px;color:var(--ed-ink);display:grid;gap:8px;text-align:left}.mf-next-grid small{color:var(--ed-muted);font-size:10px;line-height:1.45}@media(max-width:900px){.mf-marketing-kpis{grid-template-columns:repeat(2,1fr)}.mf-marketing-kpis article:nth-child(2n){border-right:0}.mf-marketing-kpis article:nth-child(-n+4){border-bottom:1px solid var(--ed-line)}.mf-overview-grid,.mf-next-grid{grid-template-columns:1fr}.mf-campaign-row{grid-template-columns:auto 1fr auto}.mf-campaign-row>span:nth-child(3),.mf-campaign-row>span:nth-child(4){display:none}}
</style>
