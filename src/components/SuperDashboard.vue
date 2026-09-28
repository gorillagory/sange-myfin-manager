<script setup>
import { ref } from 'vue';
import { Store } from '../store';
import Icon from './ui/EditionIcon.vue';
import Modal from './ui/EditionModal.vue';
import CompanyDirectory from './management/CompanyDirectory.vue';
import UserDirectory from './management/UserDirectory.vue';
import UserProfile from './dashboard/UserProfile.vue';
const tab = ref('companies'), companies = ref(Store.state.companies), directory = ref(null), profile = ref(false);
</script>
<template>
  <div class="edition-app" style="min-height:100dvh">
    <header class="ed-topbar"><div class="ed-brand"><span class="ed-brandmark"><i></i><i></i><i></i><i></i></span>myfin<small>edition</small></div><div class="ed-actions"><button class="ed-btn" @click="profile=true">My profile</button><button class="ed-icon-button" aria-label="Sign out" @click="Store.logout()"><Icon name="logout"/></button></div></header>
    <main class="ed-main" style="max-width:1400px">
      <nav class="ed-tabs ed-management-tabs" aria-label="Workspace administration"><button :class="{active:tab==='companies'}" :aria-pressed="tab==='companies'" @click="tab='companies'">Companies</button><button :class="{active:tab==='people'}" :aria-pressed="tab==='people'" @click="tab='people'">People & access</button></nav>
      <CompanyDirectory v-show="tab==='companies'" ref="directory" @loaded="companies=$event"/>
      <UserDirectory v-show="tab==='people'" global :companies="companies" @profile="profile=true" @refresh="directory?.refresh()"/>
      <footer class="ed-footer"><span>MYFIN / EDITION</span><span>Your connected business workspace</span></footer>
    </main>
    <Modal v-if="profile" title="Your profile" wide @close="profile=false"><div class="ed-legacy"><UserProfile/></div></Modal>
  </div>
</template>
