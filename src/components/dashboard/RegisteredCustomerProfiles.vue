<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Store } from '../../store';
import { api } from '../../services/api';
import { money } from '../../domain/pos';
import Icon from '../ui/EditionIcon.vue';

const emit = defineEmits(['count']);
const query = ref(''), rows = ref([]), settings = ref(null), next = ref(null);
const loading = ref(false), loadingMore = ref(false), error = ref('');
const company = computed(() => Store.state.selectedCompany || {});
const currency = computed(() => company.value.preferences?.currency || 'RM');

const consentLabel = profile => {
  const active = Object.entries(profile.marketingConsent || {}).filter(([, value]) => value?.granted).map(([channel]) => channel);
  return active.length ? active.join(', ') : 'No marketing opt-in';
};
const date = value => value ? new Intl.DateTimeFormat('en-MY', { dateStyle:'medium', timeZone:'Asia/Kuala_Lumpur' }).format(new Date(value)) : '—';

async function load({ append = false } = {}) {
  if (!company.value.id || loading.value || loadingMore.value) return;
  append ? loadingMore.value = true : loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ limit:'50' });
    if (query.value.trim()) params.set('q', query.value.trim());
    if (append && next.value) params.set('after', next.value);
    const result = await api(`/companies/${encodeURIComponent(company.value.id)}/customer-profiles?${params}`);
    rows.value = append ? [...rows.value, ...(result.rows || [])] : result.rows || [];
    settings.value = result.loyaltySettings || null;
    next.value = result.next || null;
    emit('count', rows.value.length);
  } catch (caught) { error.value = caught.message || 'Registered customer profiles could not be loaded.'; }
  finally { loading.value = false; loadingMore.value = false; }
}

watch(() => company.value.id, () => { rows.value = []; next.value = null; load(); });
onMounted(load);
</script>

<template>
  <section class="mf-customer-profiles" aria-labelledby="registered-customer-title">
    <div class="ed-filters ed-contact-filters">
      <form class="mf-customer-profile-search" @submit.prevent="load()">
        <input v-model="query" class="ed-input" aria-label="Search registered customers" placeholder="Search account name, email or phone">
        <button class="ed-btn" type="submit" :disabled="loading"><Icon name="search" />Search</button>
      </form>
      <span class="ed-muted">{{ rows.length }} loaded</span>
    </div>
    <div v-if="settings" class="ed-notice"><div><strong>Workspace loyalty</strong>{{ settings.enabled ? `One stamp per eligible paid order · ${settings.stampsRequired} stamps for ${settings.rewardLabel}` : 'Loyalty earning is paused.' }}</div></div>
    <p v-if="error" class="ed-notice error" role="alert">{{ error }}</p>
    <div v-if="loading" class="ed-empty" role="status"><span class="spinner"></span><p>Loading registered customers…</p></div>
    <div v-else class="ed-table-wrap"><table class="ed-table">
      <thead><tr><th id="registered-customer-title">Registered customer</th><th>Company activity</th><th>Loyalty</th><th>Marketing choice</th></tr></thead>
      <tbody>
        <tr v-for="profile in rows" :key="profile.customerId">
          <td><strong>{{ profile.displayName }}</strong><small>{{ profile.email || 'No account email' }} · {{ profile.emailVerified ? 'Email verified' : 'Email unverified' }}</small><small v-if="profile.phone">{{ profile.phone }}</small></td>
          <td><strong>{{ profile.paidOrderCount }} paid · {{ money(profile.paidSpend,currency) }}</strong><small>{{ profile.orderCount }} total request{{ profile.orderCount===1?'':'s' }} · last {{ date(profile.lastOrderAt) }}</small></td>
          <td><strong>{{ profile.loyaltyBalance }} stamp{{ profile.loyaltyBalance===1?'':'s' }}</strong><small>{{ settings?.enabled ? `${Math.max(0,Number(settings.stampsRequired||0)-profile.loyaltyBalance)} until ${settings.rewardLabel}` : 'Earning paused' }}</small></td>
          <td><strong>{{ consentLabel(profile) }}</strong><small>Separate workspace consent · {{ profile.active ? 'active account' : 'account suspended' }}</small></td>
        </tr>
        <tr v-if="!rows.length"><td colspan="4" class="ed-empty">No registered customer has ordered from this company yet.</td></tr>
      </tbody>
    </table></div>
    <div v-if="next" class="ed-actions ed-management-space"><button class="ed-btn" :disabled="loadingMore" @click="load({append:true})">{{ loadingMore ? 'Loading…' : 'Load more customers' }}</button></div>
    <p class="ed-muted mf-customer-profile-note">Account email verification and external identity providers are shown separately. Marketing channels appear only when the customer has opted in for this workspace.</p>
  </section>
</template>

<style scoped>
.mf-customer-profile-search{display:flex;gap:8px;flex:1}.mf-customer-profile-search .ed-input{flex:1}.mf-customer-profile-note{margin:18px 0;font-size:11px}.ed-table small{display:block;margin-top:4px}.spinner{width:26px;height:26px;border:3px solid #d8dfd8;border-top-color:#17624d;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:650px){.mf-customer-profile-search{width:100%}.ed-contact-filters{align-items:stretch}.ed-table{min-width:760px}}
</style>
