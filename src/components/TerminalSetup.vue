<script setup>
import { computed, onMounted, ref } from 'vue';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';

const token=ref(''),busy=ref(false),error=ref(''),complete=ref(false);
const context=computed(()=>Store.state.terminalContext || {});
const company=computed(()=>context.value.terminal?.companyName || Store.state.tenantContext?.company?.name || 'this company');
const enrolled=computed(()=>Boolean(context.value.enrolled && context.value.terminal));
const canonicalCompanyHost=computed(()=>Store.state.tenantContext?.surface==='tenant' && Boolean(Store.state.tenantContext?.company?.id));
const companySetupUrl=computed(()=>Store.state.selectedCompany?.hostname?`https://${Store.state.selectedCompany.hostname}/terminal-setup`:null);

onMounted(()=>Store.refreshTerminalContext({silent:true}));

async function claim(){
  error.value='';
  if(!canonicalCompanyHost.value){error.value='Open Terminal Setup from the company’s own MyFin address before entering the pairing code.';return;}
  const value=token.value.trim();
  if(value.length<6){error.value='Enter the complete pairing code from Store Network.';return;}
  busy.value=true;
  try { await Store.claimTerminal(value); complete.value=true; token.value=''; }
  catch(failure){ error.value={terminal_enrollment_invalid:'That pairing code is invalid or expired. Ask an administrator to create a new one.',terminal_unavailable:'This terminal is suspended or retired.'}[failure.message] || 'This terminal could not be enrolled. Check the code and try again.'; }
  finally{busy.value=false;}
}
</script>

<template>
  <main class="ed-terminal-setup">
    <section class="ed-terminal-setup-story">
      <div class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>terminal</small></div>
      <div><div class="ed-eyebrow">DEVICE ENROLLMENT</div><h1>Give this screen a trusted place.</h1><p>A terminal is assigned to a company, store, and work area by an owner or manager. MyFin does not scan your network or fingerprint this machine.</p></div>
      <footer class="ed-muted">COMPANY → STORE → AREA → TERMINAL</footer>
    </section>
    <section class="ed-terminal-setup-panel">
      <template v-if="enrolled">
        <span class="ed-terminal-glyph"><Icon name="check" /></span>
        <div class="ed-eyebrow">TERMINAL READY</div>
        <h1>{{ context.terminal.name }}</h1>
        <p class="ed-muted">This browser is enrolled for {{ company }}.</p>
        <dl class="ed-terminal-facts">
          <div><dt>Store</dt><dd>{{ context.store?.name || context.terminal.storeName || 'Assigned store' }}</dd></div>
          <div><dt>Area</dt><dd>{{ context.location?.name || context.terminal.locationName || 'Assigned area' }}</dd></div>
          <div><dt>Terminal code</dt><dd>{{ context.terminal.code }}</dd></div>
          <div><dt>Type</dt><dd>{{ String(context.terminal.type || 'terminal').replaceAll('_',' ') }}</dd></div>
        </dl>
        <p v-if="complete" class="ed-notice" role="status"><Icon name="check"/><span>Enrollment is complete. Staff can now use their own sign-in.</span></p>
        <router-link class="ed-btn primary" to="/poslog">Continue to staff login <Icon name="arrow" /></router-link>
        <router-link v-if="Store.state.currentUser" class="ed-btn" to="/store-network">Return to Store Network</router-link>
      </template>
      <template v-else>
        <div class="ed-eyebrow">PAIR THIS BROWSER</div>
        <h1>Enter the pairing code.</h1>
        <p class="ed-muted">An owner or manager creates this one-time code in Administration → Store Network. It expires shortly after creation.</p>
        <div v-if="!canonicalCompanyHost" class="ed-notice warning"><Icon name="alert"/><p><strong>Use the company address.</strong><br>This pairing code is valid only on its canonical company host. <a v-if="companySetupUrl" class="ed-link" :href="companySetupUrl">Open {{ companySetupUrl }}</a><span v-else>Ask the administrator for the full Terminal Setup link.</span></p></div>
        <form class="ed-terminal-enroll-form" @submit.prevent="claim">
          <label class="ed-field"><span>Pairing code</span><input v-model="token" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" :disabled="busy" required></label>
          <p v-if="error" class="ed-notice error" role="alert"><Icon name="alert"/><span>{{ error }}</span></p>
          <button class="ed-btn primary" type="submit" :disabled="busy || !Store.state.online || !canonicalCompanyHost">{{ busy?'Pairing terminal…':'Pair this terminal' }} <Icon name="arrow"/></button>
        </form>
        <div class="ed-terminal-help"><Icon name="info"/><p><strong>No pairing code?</strong><br>Sign in with a password on an administrative device, create the terminal under its store and area, then choose <em>Create pairing code</em>.</p></div>
        <router-link class="ed-link" to="/overview">Use email and password instead</router-link>
      </template>
    </section>
  </main>
</template>
