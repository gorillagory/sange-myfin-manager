<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../../../services/api';
import Icon from '../../ui/EditionIcon.vue';

const props=defineProps({
  companyId:{type:String,required:true},
  suggestedAssets:{type:Array,default:()=>[]},
  disabled:Boolean,
});
const emit=defineEmits(['use','assets-change']);
const assets=ref([]),loading=ref(false),uploading=ref(false),error=ref(''),fileInput=ref(null);
const drafts=reactive({});

const publicImage=value=>{
  const url=String(value||'').trim();
  return /^https:\/\/\S+$/i.test(url)||/^\/api\/public\/storefront-assets\/[A-Za-z0-9_-]+$/.test(url)?url:'';
};
const normalizedAssets=computed(()=>{
  const seen=new Set(),rows=[];
  for(const source of [...assets.value,...props.suggestedAssets]){
    const publicUrl=publicImage(source.publicUrl||source.url);
    if(!publicUrl||seen.has(publicUrl))continue;
    seen.add(publicUrl);
    rows.push({...source,url:publicUrl,publicUrl,previewUrl:source.url||publicUrl,label:String(source.label||source.name||'Brand asset').trim()||'Brand asset',managed:!!source.id&&!source.suggested});
  }
  return rows;
});

function assetRows(result){return Array.isArray(result)?result:(result?.assets||result?.rows||[]);}
function syncDrafts(){for(const row of assets.value)drafts[row.id]={label:row.label||row.name||'',altText:row.altText||''};}
async function load(){
  if(!props.companyId)return;
  loading.value=true;error.value='';
  try{assets.value=assetRows(await api(`/companies/${encodeURIComponent(props.companyId)}/storefront/assets`));syncDrafts();emit('assets-change',normalizedAssets.value);}
  catch(caught){error.value=caught.status===404?'Asset uploads are being prepared for this workspace. Saved image links remain available.':caught.message;assets.value=[];emit('assets-change',normalizedAssets.value);}
  finally{loading.value=false;}
}
async function upload(event){
  const file=event.target.files?.[0];event.target.value='';if(!file||uploading.value)return;
  error.value='';
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){error.value='Choose a PNG, JPEG or WebP image up to 5 MB.';return;}
  uploading.value=true;
  try{
    const body=new FormData();body.append('file',file);
    const result=await api(`/companies/${encodeURIComponent(props.companyId)}/files/assets`,{method:'POST',body});
    const row=result.asset||result;
    if(!publicImage(row.publicUrl||row.url))throw new Error('The upload did not return a public storefront image.');
    assets.value=[row,...assets.value.filter(item=>item.id!==row.id)];syncDrafts();emit('assets-change',normalizedAssets.value);
  }catch(caught){error.value=caught.message||'The image could not be uploaded.';}
  finally{uploading.value=false;}
}
async function saveMetadata(row){
  if(!row.id||props.disabled)return;
  const draft=drafts[row.id]||{};error.value='';
  try{
    const result=await api(`/companies/${encodeURIComponent(props.companyId)}/storefront/assets/${encodeURIComponent(row.id)}`,{method:'PATCH',body:{label:String(draft.label||'').trim(),altText:String(draft.altText||'').trim()}});
    const updated=result.asset||result;assets.value=assets.value.map(item=>item.id===row.id?{...item,...updated}:item);syncDrafts();emit('assets-change',normalizedAssets.value);
  }catch(caught){error.value=caught.message||'The asset details could not be saved.';}
}
async function remove(row){
  if(!row.id||props.disabled)return;
  error.value='';
  try{await api(`/files/${encodeURIComponent(row.id)}`,{method:'DELETE'});assets.value=assets.value.filter(item=>item.id!==row.id);delete drafts[row.id];emit('assets-change',normalizedAssets.value);}
  catch(caught){error.value=caught.message==='file_is_referenced'?'This image is still used by the storefront. Replace it there before removing it from the library.':caught.message;}
}
function use(row,target){emit('use',{target,url:row.publicUrl||row.url,asset:row});}
watch(()=>props.companyId,load);
watch(()=>props.suggestedAssets,()=>emit('assets-change',normalizedAssets.value),{deep:true});
onMounted(load);
</script>

<template>
  <section class="mf-asset-library" aria-labelledby="storefront-asset-title">
    <header><div><span class="ed-eyebrow">WORKSPACE RESOURCES</span><h4 id="storefront-asset-title">Brand asset library</h4><p>Upload once, then reuse the same logo or banner across the customer storefront and promotions.</p></div><button class="ed-btn primary" type="button" :disabled="disabled||uploading" @click="fileInput?.click()"><Icon name="plus"/>{{ uploading?'Uploading…':'Upload image' }}</button><input ref="fileInput" class="mf-visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" @change="upload"></header>
    <p v-if="error" class="ed-notice warning" role="alert">{{ error }}</p>
    <div v-if="loading" class="mf-asset-loading" role="status">Loading saved brand assets…</div>
    <div v-else-if="normalizedAssets.length" class="mf-asset-grid">
      <article v-for="row in normalizedAssets" :key="row.id||row.url" class="mf-asset-card">
        <div class="mf-asset-preview"><img :src="row.previewUrl" :alt="row.altText||''" loading="lazy"><span v-if="row.managed">Saved</span><span v-else>In use</span></div>
        <div class="mf-asset-copy">
          <template v-if="row.managed"><label><span>Name</span><input v-model="drafts[row.id].label" maxlength="120" :disabled="disabled"></label><label><span>Alt text</span><input v-model="drafts[row.id].altText" maxlength="240" placeholder="Describe the image" :disabled="disabled"></label></template>
          <strong v-else>{{ row.label }}</strong>
          <small>{{ row.mime||row.kind||'Storefront image' }}<template v-if="row.size"> · {{ Math.ceil(row.size/1024) }} KB</template></small>
        </div>
        <div class="mf-asset-actions"><button class="ed-btn small" type="button" @click="use(row,'logo')">Use as logo</button><button class="ed-btn small" type="button" @click="use(row,'hero')">Use as hero</button><button v-if="row.managed" class="ed-btn small" type="button" :disabled="disabled" @click="saveMetadata(row)">Save details</button><button v-if="row.managed" class="ed-btn small danger" type="button" :disabled="disabled" @click="remove(row)">Remove</button></div>
      </article>
    </div>
    <div v-else class="mf-asset-empty"><Icon name="image"/><div><strong>Your reusable images will appear here.</strong><span>Upload a logo or a wide JPG, PNG, or WebP banner up to 5 MB.</span></div></div>
  </section>
</template>

<style scoped>
.mf-asset-library{grid-column:1/-1;display:grid;gap:14px;margin-top:6px;padding:18px;border:1px solid var(--ed-line);border-radius:12px;background:var(--ed-soft)}.mf-asset-library>header{display:flex;align-items:center;justify-content:space-between;gap:18px}.mf-asset-library h4{margin:4px 0;font-size:16px}.mf-asset-library header p{max-width:620px;margin:0;color:var(--ed-muted);font-size:10px;line-height:1.5}.mf-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.mf-asset-loading{padding:24px;color:var(--ed-muted);text-align:center;font-size:11px}.mf-asset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:10px}.mf-asset-card{min-width:0;display:grid;grid-template-rows:142px auto auto;overflow:hidden;border:1px solid var(--ed-line);border-radius:10px;background:var(--ed-bg)}.mf-asset-preview{position:relative;background:#e9eee9}.mf-asset-preview img{width:100%;height:100%;object-fit:cover}.mf-asset-preview span{position:absolute;top:9px;left:9px;padding:4px 7px;border-radius:999px;background:#102b23cc;color:#fff;font-size:8px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.mf-asset-copy{display:grid;gap:8px;padding:12px}.mf-asset-copy label{display:grid;gap:4px}.mf-asset-copy label span,.mf-asset-copy small{font-size:9px;color:var(--ed-muted)}.mf-asset-copy input{width:100%;min-height:34px;padding:6px 8px;border:1px solid var(--ed-line);border-radius:6px;background:var(--ed-bg);color:inherit;font-size:11px}.mf-asset-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 12px 12px}.mf-asset-empty{display:flex;align-items:center;gap:12px;padding:20px;border:1px dashed var(--ed-line);border-radius:9px}.mf-asset-empty div{display:grid;gap:3px}.mf-asset-empty strong{font-size:11px}.mf-asset-empty span{font-size:9px;color:var(--ed-muted)}@media(max-width:600px){.mf-asset-library{padding:14px}.mf-asset-library>header{align-items:stretch;flex-direction:column}.mf-asset-grid{grid-template-columns:1fr}.mf-asset-card{grid-template-rows:125px auto auto}.mf-asset-actions .ed-btn{flex:1}}
</style>
