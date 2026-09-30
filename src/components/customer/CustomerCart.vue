<script setup>
import { computed } from 'vue';
import { formatCustomerMoney } from '../../domain/customerOrdering';

const props = defineProps({
  lines: { type: Array, default: () => [] },
  currency: { type: String, default: 'RM' },
  quote: { type: Object, default: null },
  busy: Boolean,
});
const emit = defineEmits(['quantity', 'review']);
const itemCount = computed(() => props.lines.reduce((sum, line) => sum + line.quantity, 0));
const estimate = computed(() => props.lines.reduce((sum, line) => sum + line.price * line.quantity, 0));
</script>

<template>
  <aside class="customer-cart" aria-label="Your order">
    <header><div><span class="customer-kicker">YOUR ORDER</span><h2>{{ itemCount }} {{ itemCount === 1 ? 'item' : 'items' }}</h2></div>
      <span class="customer-cart-mark" aria-hidden="true">{{ itemCount }}</span></header>
    <div v-if="!lines.length" class="customer-cart-empty"><span aria-hidden="true">＋</span><strong>Your order is empty</strong><p>Choose something from the menu to begin.</p></div>
    <div v-else class="customer-cart-lines">
      <article v-for="line in lines" :key="line.key" class="customer-cart-line">
        <div><strong>{{ line.name }}</strong><small v-if="line.variantName">{{ line.variantName }}</small>
          <small>{{ formatCustomerMoney(line.price, currency) }} each</small></div>
        <div class="customer-quantity" :aria-label="`Quantity for ${line.name}`">
          <button type="button" :aria-label="`Remove one ${line.name}`" @click="emit('quantity', line.key, line.quantity - 1)">−</button>
          <output>{{ line.quantity }}</output>
          <button type="button" :disabled="line.quantity >= line.maxQuantity" :aria-label="`Add one ${line.name}`" @click="emit('quantity', line.key, line.quantity + 1)">+</button>
        </div>
        <strong class="customer-line-total">{{ formatCustomerMoney(line.price * line.quantity, currency) }}</strong>
      </article>
    </div>
    <footer v-if="lines.length">
      <div class="customer-cart-total"><span>{{ quote ? 'Quoted total' : 'Estimated total' }}</span>
        <strong>{{ formatCustomerMoney(quote?.total ?? estimate, quote?.currency || currency) }}</strong></div>
      <p>Final pricing and availability are checked by the shop before you place the order.</p>
      <button type="button" class="customer-primary" :disabled="busy" @click="emit('review')">{{ busy ? 'Checking…' : 'Review order' }} <span aria-hidden="true">→</span></button>
    </footer>
  </aside>
</template>

<style scoped>
.customer-cart{position:sticky;top:24px;align-self:start;border:1px solid var(--customer-line);background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 18px 55px #183d2a10}.customer-cart header{display:flex;align-items:center;justify-content:space-between;padding:22px 22px 18px;border-bottom:1px solid var(--customer-line)}.customer-kicker{display:block;font-size:10px;letter-spacing:.18em;font-weight:700;color:var(--customer-muted)}.customer-cart h2{margin:5px 0 0;font:400 25px/1.1 Georgia,serif}.customer-cart-mark{display:grid;place-items:center;min-width:34px;height:34px;padding:0 9px;border-radius:50%;background:var(--customer-accent);color:#fff;font-size:12px;font-weight:700}.customer-cart-empty{min-height:230px;display:grid;place-content:center;justify-items:center;text-align:center;padding:30px;color:var(--customer-muted)}.customer-cart-empty>span{font-size:30px;font-weight:200;color:var(--customer-line-strong)}.customer-cart-empty strong{margin-top:13px;color:var(--customer-ink)}.customer-cart-empty p{margin:6px 0 0;font-size:12px}.customer-cart-lines{max-height:min(48vh,480px);overflow:auto;padding:6px 22px}.customer-cart-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 16px;padding:17px 0;border-bottom:1px solid var(--customer-line)}.customer-cart-line>div:first-child{display:flex;flex-direction:column;gap:3px;min-width:0}.customer-cart-line strong{font-size:13px}.customer-cart-line small{font-size:11px;color:var(--customer-muted)}.customer-quantity{display:flex;align-items:center;align-self:center;border:1px solid var(--customer-line);border-radius:999px;overflow:hidden}.customer-quantity button{width:34px;height:34px;border:0;background:#fff;color:var(--customer-ink);font-size:18px}.customer-quantity button:hover:not(:disabled){background:var(--customer-tint)}.customer-quantity button:disabled{opacity:.3}.customer-quantity output{min-width:26px;text-align:center;font-size:12px;font-weight:700}.customer-line-total{grid-column:1/-1;text-align:right}.customer-cart footer{padding:20px 22px 22px;background:var(--customer-tint)}.customer-cart-total{display:flex;justify-content:space-between;align-items:end;gap:15px}.customer-cart-total span{font-size:12px;color:var(--customer-muted)}.customer-cart-total strong{font:400 24px/1 Georgia,serif}.customer-cart footer p{font-size:10px;line-height:1.5;color:var(--customer-muted);margin:10px 0 16px}.customer-primary{width:100%;min-height:48px;display:flex;align-items:center;justify-content:space-between;border:0;border-radius:8px;background:var(--customer-accent);color:#fff;padding:0 17px;font-weight:700}.customer-primary:hover:not(:disabled){background:var(--customer-accent-dark)}.customer-primary:disabled{opacity:.55}
@media(max-width:920px){.customer-cart{position:static}.customer-cart-lines{max-height:none}}
</style>
