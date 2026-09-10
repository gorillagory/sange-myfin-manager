<script setup>
import { useAttrs } from 'vue';
import Icon from './EditionIcon.vue';
const attrs=useAttrs();
const names={ 'plus':'plus','times':'close','trash':'trash','trash-alt':'trash','edit':'edit','user':'people','user-plus':'people','users-slash':'people','truck':'truck','building':'building','check':'check','check-circle':'check','check-square':'check','save':'check','envelope':'mail','coins':'wallet','map-marker-alt':'pin','phone':'phone','image':'image','percent':'percent','qrcode':'qr','info-circle':'alert','exclamation-circle':'alert','file-invoice':'receipt','file-pdf':'receipt','arrow-left':'arrow-left','arrow-up':'arrow-up','chevron-right':'arrow','magic':'spark','folder-open':'folder','wallet':'wallet','piggy-bank':'wallet','chart-line':'chart','chart-line-down':'chart','chart-bar':'chart','clock':'clock','history':'clock','pause-circle':'clock','cash-register':'bag','shopping-cart':'bag','print':'printer','credit-card':'card','search':'search' };
const name=()=>String(attrs.class||'').split(/\s+/).map(c=>names[c.replace(/^fa-/,'')]).find(Boolean)||'grid';
</script>
<template><Icon :name="name()" class="ed-legacy-icon" /></template>
<style>.ed-legacy-icon{display:inline-block;width:1em;height:1em;vertical-align:-.12em}</style>
