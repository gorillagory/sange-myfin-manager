<script setup>
import { computed, onMounted, ref } from 'vue';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';

const code=ref(''),busy=ref(false),checkingTerminal=ref(true),error=ref('');
const context=computed(()=>Store.state.terminalContext || {});
const enrolled=computed(()=>Boolean(context.value.enrolled && context.value.terminal));
const terminalRequired=computed(()=>Boolean(context.value.policy?.terminalEnforcement));
const blocked=computed(()=>terminalRequired.value && !enrolled.value);
const place=computed(()=>[context.value.store?.name,context.value.location?.name].filter(Boolean).join(' · '));

onMounted(async()=>{await Store.refreshTerminalContext({silent:true});checkingTerminal.value=false;});
async function login(){
  if(busy.value||blocked.value)return;
  error.value='';
  if(!/^\d{6}$/.test(code.value)){error.value='Enter the six-digit access code.';return;}
  busy.value=true;
  try{if(!await Store.posLogin(code.value))error.value='That access code is not valid for this company or terminal.';}
  finally{busy.value=false;}
}
</script>

<template>
  <div class="ed-login">
    <section class="ed-login-story"><div class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>pos</small></div><div><div class="ed-eyebrow">{{ Store.state.tenantContext?.workspace?.name }}</div><h1>{{ Store.state.tenantContext?.company?.name }}</h1><p>Personal staff access, tied to the place where this terminal was enrolled.</p><div class="ed-login-lines" aria-hidden="true"></div></div><footer class="ed-eyebrow">SECURE COMPANY POS ACCESS</footer></section>
    <section class="ed-login-form">
      <div class="ed-eyebrow">STAFF LOGIN</div><h1>Ready for<br>the next shift.</h1>
      <div v-if="checkingTerminal" class="ed-notice" role="status">Checking this terminal…</div>
      <div v-else-if="enrolled" class="mf-login-terminal"><span class="ed-terminal-glyph"><Icon name="settings"/></span><span><strong>{{ context.terminal.name }}</strong><small>{{ place }} · {{ context.terminal.code }}</small></span><span class="ed-pill">Paired</span></div>
      <div v-else class="ed-notice" :class="{warning:terminalRequired}"><Icon :name="terminalRequired?'alert':'info'"/><div><strong>{{ terminalRequired?'Terminal pairing is required':'Unpaired browser' }}</strong>{{ terminalRequired?'Ask an owner or manager for a pairing code before staff sign-in.':'Legacy staff login remains available until terminal enforcement is enabled.' }} <router-link class="ed-link" to="/terminal-setup">Set up terminal</router-link></div></div>
      <p class="ed-muted">Enter your personal six-digit staff code.</p>
      <form @submit.prevent="login"><div class="ed-field"><label for="pos-code">Staff access code</label><input id="pos-code" v-model="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" :disabled="blocked" required></div><p v-if="error" class="ed-login-error" role="alert">{{ error }}</p><button class="ed-btn primary" type="submit" :disabled="busy||checkingTerminal||blocked">{{ busy?'Checking…':'Open staff workspace' }}<Icon name="arrow" /></button></form>
      <router-link class="ed-btn" to="/overview">Sign in with email and password</router-link><footer>Administrative settings require password sign-in.</footer>
    </section>
  </div>
</template>
