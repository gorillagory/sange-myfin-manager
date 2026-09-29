<script setup>
import {computed} from 'vue';
import {money} from '../../../domain/pos';
import {categoryPath} from '../../../domain/inventoryCsv';
const props=defineProps({products:{type:Array,required:true},currency:{type:String,default:'RM'},canDelete:Boolean,canWrite:Boolean});
defineEmits(['edit','delete','resources']);
const groups=computed(()=>{
  const result=[];
  for(const product of props.products){
    const path=categoryPath(product),key=path.join('\u0000');
    let group=result.find(value=>value.key===key);
    if(!group){group={key,label:path.join(' / '),products:[]};result.push(group);}
    group.products.push(product);
  }
  return result;
});
</script>
<template><div class="ed-table-wrap ed-inventory-list"><table class="ed-table">
<thead><tr><th>Product / SKU</th><th>Category</th><th class="num">Stock</th><th class="num">Price</th><th class="num">Actions</th></tr></thead>
<tbody><template v-for="group in groups" :key="group.key"><tr class="ed-inventory-group"><td colspan="5">{{ group.label }} <small>{{ group.products.length }} {{ group.products.length===1?'product':'products' }}</small></td></tr><tr v-for="p in group.products" :key="p.id||p.sku">
  <td><div class="ed-actions"><img v-if="p.imageUrl" :src="p.imageUrl" class="ed-product-thumb" alt="" loading="lazy"><div><strong>{{ p.name }}</strong><small>{{ p.sku||'No SKU' }}</small></div></div></td>
  <td><span class="ed-pill">{{ categoryPath(p).join(' / ') }}</span></td>
  <td class="num"><span v-if="!p.trackStock" class="ed-muted">Not tracked</span><span v-else-if="p.variants?.length">{{ p.variants.reduce((s,v)=>s+Number(v.stock||0),0) }}<small>{{ p.variants.length }} variants</small></span><span v-else :class="{'ed-low-stock':p.stock<=5}">{{ p.stock }} {{ p.unit||'pcs' }}</span></td>
  <td class="num"><template v-if="p.variants?.length">{{ money(Math.min(...p.variants.map(v=>v.price)),currency) }}<small>to {{ money(Math.max(...p.variants.map(v=>v.price)),currency) }}</small></template><template v-else>{{ money(p.price,currency) }}</template></td>
  <td><div class="ed-actions ed-inventory-actions"><button v-if="canWrite" class="ed-btn" :aria-label="`Resources for ${p.name}`" @click="$emit('resources',p)">QR / Labels</button><button v-if="canWrite" class="ed-btn" :aria-label="`Edit ${p.name}`" @click="$emit('edit',p)">Edit</button><button v-if="canDelete" class="ed-btn danger" :aria-label="`Delete ${p.name}`" @click="$emit('delete',p)">Delete</button></div></td>
</tr></template><tr v-if="!products.length"><td colspan="5" class="ed-empty">No products match this catalog view.</td></tr></tbody></table></div></template>
