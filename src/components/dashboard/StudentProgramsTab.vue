<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

const router=useRouter();
onMounted(()=>router.replace({path:'/marketing',query:{tab:'eligibility'}}));
</script>

<template>
  <section class="ed-page" aria-live="polite">
    <div class="ed-empty"><h1>Student Programs moved.</h1><p>Eligibility is now one part of Sales &amp; Marketing.</p><RouterLink class="ed-btn primary" to="/marketing?tab=eligibility">Open customer eligibility</RouterLink></div>
  </section>
</template>
