<script setup>
import { computed, onMounted, ref } from 'vue';
import { normalizeStorefront } from '../../domain/customerOrdering';
import { loadStorefront } from '../../services/customerOrdering';

const menu = ref(null);
const loading = ref(true);
const error = ref('');
const storefront = computed(() => menu.value?.storefront || {});
const privacy = computed(() => storefront.value.privacy || {});

onMounted(async () => {
  try { menu.value = normalizeStorefront(await loadStorefront()); }
  catch { error.value = 'This shop privacy notice is unavailable.'; }
  finally { loading.value = false; }
});
</script>

<template>
  <div class="privacy-shell">
    <header><RouterLink to="/shop" class="wordmark"><i aria-hidden="true"></i> myfin <small>order</small></RouterLink><RouterLink to="/shop" class="back">Back to menu</RouterLink></header>
    <main v-if="loading" class="state" role="status">Opening the privacy notice…</main>
    <main v-else-if="error || !menu" class="state"><h1>Notice unavailable</h1><p>{{ error }}</p><RouterLink to="/shop">Return to the menu</RouterLink></main>
    <main v-else>
      <section class="hero"><span>PRIVACY NOTICE / NOTIS PRIVASI</span><h1>Your information at {{ storefront.name }}</h1><p>This page explains how customer account, ordering and loyalty information is handled at this workspace.</p></section>
      <section class="controller"><div><span>DATA CONTROLLER</span><strong>{{ privacy.controllerName }}</strong></div><div><span>CONTACT</span><strong>{{ privacy.controllerContact }}</strong></div><div><span>GUEST CONTACT RETENTION</span><strong>{{ privacy.guestContactRetentionDays }} days after an order closes</strong></div></section>
      <div class="notice-grid">
        <article lang="en">
          <span>ENGLISH</span><h2>Customer privacy notice</h2><p class="summary">{{ privacy.noticeEn }}</p>
          <h3>Information we use</h3><p>For an order, we use the items, collection location, order status, name and any contact details or preparation notes you choose to provide. For an optional account, we also use your email, password credential, workspace profile, session, order history, loyalty balance and marketing choices.</p>
          <h3>Why we use it</h3><p>We use this information to quote and fulfil orders, contact you about an order, prevent duplicate or abusive requests, maintain your account, award workspace loyalty stamps, record your choices and support the service. Marketing is separate and only follows the channels you switch on for this workspace.</p>
          <h3>Account and workspace scope</h3><p>Your login works across participating finn3 shops. Each workspace keeps its own profile, loyalty balance and marketing choices. Guest ordering remains available without an account. Customer accounts are limited to people who confirm they are at least 18.</p>
          <h3>Retention and payment</h3><p>Guest contact details and freeform order notes are removed {{ privacy.guestContactRetentionDays }} days after the order is paid, cancelled or expires. Transaction, order status, stock and consent records may be retained for operational, accounting, security and legal needs. Orders are paid at the counter; this storefront does not collect online card details.</p>
          <h3>Your choices and rights</h3><p>You can review or change your workspace profile and withdraw any marketing channel in your account. Contact the controller above to ask about access, correction, withdrawal or another request concerning your personal data.</p>
        </article>
        <article lang="ms">
          <span>BAHASA MELAYU</span><h2>Notis privasi pelanggan</h2><p class="summary">{{ privacy.noticeMs }}</p>
          <h3>Maklumat yang kami gunakan</h3><p>Untuk pesanan, kami menggunakan item, lokasi pengambilan, status pesanan, nama serta butiran hubungan atau nota penyediaan yang anda pilih untuk berikan. Untuk akaun pilihan, kami juga menggunakan e-mel, kelayakan kata laluan, profil ruang kerja, sesi, sejarah pesanan, baki kesetiaan dan pilihan pemasaran anda.</p>
          <h3>Tujuan penggunaannya</h3><p>Kami menggunakan maklumat ini untuk memberi sebut harga dan memenuhi pesanan, menghubungi anda tentang pesanan, mencegah permintaan berulang atau penyalahgunaan, mengurus akaun, memberikan cap kesetiaan ruang kerja, merekod pilihan anda dan menyokong perkhidmatan. Pemasaran adalah berasingan dan hanya mengikut saluran yang anda hidupkan untuk ruang kerja ini.</p>
          <h3>Skop akaun dan ruang kerja</h3><p>Log masuk anda boleh digunakan di kedai finn3 yang mengambil bahagian. Setiap ruang kerja menyimpan profil, baki kesetiaan dan pilihan pemasarannya sendiri. Pesanan tetamu kekal tersedia tanpa akaun. Akaun pelanggan dihadkan kepada orang yang mengesahkan bahawa mereka berumur sekurang-kurangnya 18 tahun.</p>
          <h3>Penyimpanan dan bayaran</h3><p>Butiran hubungan tetamu dan nota pesanan bebas dipadam {{ privacy.guestContactRetentionDays }} hari selepas pesanan dibayar, dibatalkan atau tamat tempoh. Rekod transaksi, status pesanan, stok dan persetujuan boleh disimpan untuk keperluan operasi, perakaunan, keselamatan dan undang-undang. Pesanan dibayar di kaunter; kedai dalam talian ini tidak mengumpul butiran kad pembayaran.</p>
          <h3>Pilihan dan hak anda</h3><p>Anda boleh menyemak atau mengubah profil ruang kerja dan menarik balik mana-mana saluran pemasaran dalam akaun anda. Hubungi pengawal di atas untuk meminta akses, pembetulan, penarikan balik atau permintaan lain berkaitan data peribadi anda.</p>
        </article>
      </div>
      <footer><p>Presented from the shop's current privacy configuration. / Dipaparkan daripada konfigurasi privasi semasa kedai.</p><RouterLink to="/shop">Continue to menu →</RouterLink></footer>
    </main>
  </div>
</template>

<style scoped>
.privacy-shell{--ink:#15382c;--muted:#68776f;--line:#d8dfd8;--tint:#f1f5ed;--accent:#17624d;min-height:100dvh;background:#fbfcf8;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}.privacy-shell>header{height:78px;display:flex;align-items:center;justify-content:space-between;max-width:1180px;margin:auto;padding:0 42px;border-bottom:1px solid var(--line)}.wordmark{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font:bold 21px Georgia,serif}.wordmark i{width:13px;height:13px;background:var(--accent);box-shadow:6px -6px 0 #8dad9c}.wordmark small{font:500 10px Inter,sans-serif;letter-spacing:.15em}.back{color:var(--accent);font-size:11px;font-weight:700}.privacy-shell main{max-width:1180px;margin:auto;padding:0 42px 50px}.state{min-height:calc(100dvh - 78px);display:grid;place-content:center;justify-items:center;gap:12px;text-align:center}.state h1{font:400 42px Georgia,serif;margin:0}.state p{color:var(--muted)}.state a{color:var(--accent);font-weight:700}.hero{padding:58px 0 38px;max-width:760px}.hero>span,.controller span,.notice-grid article>span{font-size:9px;letter-spacing:.18em;font-weight:750;color:var(--muted)}.hero h1{font:400 clamp(46px,7vw,78px)/.98 Georgia,serif;letter-spacing:-.035em;margin:12px 0 18px}.hero p{font-size:14px;line-height:1.6;color:var(--muted)}.controller{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--line);margin-bottom:38px}.controller>div{display:flex;flex-direction:column;gap:8px;padding:20px}.controller>div+div{border-left:1px solid var(--line)}.controller strong{font-size:12px;line-height:1.45}.notice-grid{display:grid;grid-template-columns:1fr 1fr;gap:50px}.notice-grid article+article{border-left:1px solid var(--line);padding-left:50px}.notice-grid h2{font:400 32px Georgia,serif;margin:8px 0 20px}.notice-grid h3{font-size:12px;margin:24px 0 7px}.notice-grid p{font-size:11px;line-height:1.7;color:var(--muted);margin:0}.notice-grid .summary{font-size:12px;color:var(--ink);padding:15px;background:var(--tint);border-radius:8px}.privacy-shell footer{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--line);margin-top:42px;padding:24px 0;color:var(--muted);font-size:10px}.privacy-shell footer a{color:var(--accent);font-weight:750;text-decoration:none}@media(max-width:760px){.privacy-shell>header,.privacy-shell main{padding-inline:20px}.controller,.notice-grid{grid-template-columns:1fr}.controller>div+div{border-left:0;border-top:1px solid var(--line)}.notice-grid{gap:35px}.notice-grid article+article{border-left:0;border-top:1px solid var(--line);padding:35px 0 0}.privacy-shell footer{align-items:start;flex-direction:column}.hero{padding-top:38px}.hero h1{font-size:46px}}
</style>
