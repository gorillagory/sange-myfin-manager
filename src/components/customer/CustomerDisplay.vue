<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { accessibleStorefrontText, normalizeStorefront, storefrontFontStack } from '../../domain/customerOrdering';
import { loadStorefront } from '../../services/customerOrdering';

const menu=ref(null),loading=ref(true),error=ref(''),actionError=ref(''),active=ref(0),qrImage=ref('');
const carouselPaused=ref(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false);
const shopUrl=computed(()=>`${location.origin}/shop`);
const storefront=computed(()=>menu.value?.storefront||{});
const slides=computed(()=>menu.value?.slides?.length?menu.value.slides:[{
  id:'hero',badge:storefront.value.hero?.eyebrow||'ORDER ONLINE',
  title:storefront.value.hero?.title||storefront.value.name||'Order online',
  description:storefront.value.hero?.description||storefront.value.description||'Scan to browse the menu and order.',
  imageUrl:storefront.value.hero?.imageUrl||'',backgroundColor:storefront.value.theme?.primaryColor||'#17624d',
}]);
const slide=computed(()=>slides.value[active.value%slides.value.length]||null);
const fulfillmentLabel=computed(()=>{
  const pickup=(menu.value?.locations||[]).some(location=>location.fulfillmentMode!=='table');
  const delivery=(menu.value?.deliveryZones||[]).length>0;
  return pickup&&delivery?'Pickup or delivery':delivery?'Delivery':'Pickup';
});
const displayInk=computed(()=>slide.value?.imageUrl?'#ffffff':accessibleStorefrontText(
  slide.value?.backgroundColor||'#17624d',storefront.value.theme?.textColor||'#ffffff'));
const displayAccent=computed(()=>accessibleStorefrontText(
  slide.value?.imageUrl?'#0d201d':slide.value?.backgroundColor||'#17624d',
  storefront.value.theme?.accentColor||'#d7a43b'));
const displayStyle=computed(()=>({ '--display-accent':storefront.value.theme?.accentColor||'#d7a43b',
  '--display-accent-readable':displayAccent.value,
  '--display-ink':displayInk.value,
  '--display-font':storefrontFontStack(storefront.value.theme?.fontFamily) }));
let timer=null,refreshTimer=null;

function start(){
  if(timer)clearInterval(timer);
  if(slides.value.length>1&&!carouselPaused.value)timer=setInterval(()=>{active.value=(active.value+1)%slides.value.length;},
    Number(storefront.value.carouselIntervalSeconds||7)*1000);
}
async function load(quiet=false){
  if(!quiet){loading.value=true;error.value='';}
  try{
    const next=normalizeStorefront(await loadStorefront());
    const nextQr=await QRCode.toDataURL(shopUrl.value,{width:800,margin:2,errorCorrectionLevel:'H'});
    menu.value=next;qrImage.value=nextQr;active.value=slides.value.length?active.value%slides.value.length:0;actionError.value='';start();
  }
  catch(caught){
    const withdrawn=['storefront_not_found','storefront_unavailable'].includes(caught?.message);
    const message=withdrawn?'This storefront is not published.':'The storefront display could not be loaded.';
    if(withdrawn){menu.value=null;qrImage.value='';error.value=message;actionError.value='';if(timer)clearInterval(timer);}
    else if(!quiet||!menu.value)error.value=message;
    else actionError.value=`${message} Showing the last successful version.`;
  }
  finally{if(!quiet)loading.value=false;}
}
function select(index){active.value=index;start();}
function toggleCarousel(){carouselPaused.value=!carouselPaused.value;start();}
function refreshVisible(){if(!document.hidden)load(true);}
async function printBanner(){document.body.classList.add('customer-display-printing');await nextTick();window.print();setTimeout(()=>document.body.classList.remove('customer-display-printing'),800);}
function wrap(context,value,x,y,width,lineHeight,maxLines=4){
  const words=String(value||'').split(/\s+/);let line='',lineNo=0;
  for(const word of words){const next=line?`${line} ${word}`:word;if(context.measureText(next).width>width&&line){context.fillText(line,x,y+lineNo*lineHeight);line=word;if(++lineNo>=maxLines)return;}else line=next;}
  if(line&&lineNo<maxLines)context.fillText(line,x,y+lineNo*lineHeight);
}
async function loadCanvasImage(url){
  if(!url)return null;
  const image=new Image();
  if(!url.startsWith('data:'))image.crossOrigin='anonymous';
  image.referrerPolicy='no-referrer';image.src=url;
  try{await image.decode();return image;}catch{return null;}
}
function drawCover(context,image,x,y,width,height){
  const scale=Math.max(width/image.naturalWidth,height/image.naturalHeight);
  const drawnWidth=image.naturalWidth*scale,drawnHeight=image.naturalHeight*scale;
  context.drawImage(image,x+(width-drawnWidth)/2,y+(height-drawnHeight)/2,drawnWidth,drawnHeight);
}
async function downloadBanner(){
  actionError.value='';
  const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;const context=canvas.getContext('2d');
  context.fillStyle=slide.value?.backgroundColor||'#17624d';context.fillRect(0,0,1600,900);
  const [backdrop,logo,qrCode]=await Promise.all([
    loadCanvasImage(slide.value?.imageUrl),loadCanvasImage(storefront.value.logoUrl),loadCanvasImage(qrImage.value),
  ]);
  if((slide.value?.imageUrl&&!backdrop)||(storefront.value.logoUrl&&!logo)||!qrCode){
    actionError.value='The downloadable banner cannot include one of the configured images because its host blocks reuse. Print this banner instead, or use an image host that allows CORS.';
    return;
  }
  if(backdrop){drawCover(context,backdrop,0,0,1600,900);context.fillStyle='#0d201dbd';context.fillRect(0,0,1600,900);}
  const ink=backdrop?'#ffffff':accessibleStorefrontText(slide.value?.backgroundColor||'#17624d',storefront.value.theme?.textColor||'#ffffff');
  const font=storefrontFontStack(storefront.value.theme?.fontFamily);
  context.fillStyle=ink;
  if(logo){context.fillStyle='#ffffff';context.beginPath();context.roundRect(90,62,72,72,12);context.fill();context.drawImage(logo,98,70,56,56);}
  context.font=`700 28px ${font}`;context.fillStyle=ink;context.fillText(storefront.value.name||'Online ordering',logo?182:90,108);
  context.font=`700 30px ${font}`;context.fillText((slide.value?.badge||'ORDER ONLINE').toUpperCase(),90,180);
  context.font=`700 82px ${font}`;wrap(context,slide.value?.title||storefront.value.name,90,280,940,92,4);
  context.font=`400 30px ${font}`;context.globalAlpha=.88;wrap(context,slide.value?.description,90,665,900,42,3);context.globalAlpha=1;
  context.fillStyle='#fff';context.beginPath();context.roundRect(1190,170,320,430,24);context.fill();if(qrCode)context.drawImage(qrCode,1220,200,260,260);
  context.fillStyle='#17251f';context.textAlign='center';context.font='700 24px system-ui';context.fillText('SCAN TO ORDER',1350,510);context.font='400 18px system-ui';context.fillText(shopUrl.value,1350,550);context.textAlign='left';
  context.font=`700 28px ${font}`;context.fillStyle=ink;context.fillText(`ORDER ONLINE · ${fulfillmentLabel.value.toUpperCase()}`,90,830);
  try{const link=document.createElement('a');link.href=canvas.toDataURL('image/png');link.download=`${(storefront.value.name||'shop').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-order-banner.png`;link.click();}
  catch{actionError.value='The banner image could not be downloaded. Check that the configured image host allows reuse, or print the banner instead.';}
}
onMounted(async()=>{await load();refreshTimer=setInterval(()=>load(true),120000);document.addEventListener('visibilitychange',refreshVisible);});
onBeforeUnmount(()=>{if(timer)clearInterval(timer);if(refreshTimer)clearInterval(refreshTimer);document.removeEventListener('visibilitychange',refreshVisible);});
</script>

<template>
  <main class="customer-display" :style="displayStyle">
    <div v-if="loading" class="display-state">Opening storefront display…</div>
    <div v-else-if="error" class="display-state"><strong>Display unavailable</strong><span>{{ error }}</span><button @click="load">Try again</button></div>
    <section v-else-if="slide" class="display-slide" :style="{backgroundColor:slide.backgroundColor}">
      <img v-if="slide.imageUrl" class="display-backdrop" :src="slide.imageUrl" alt="" referrerpolicy="no-referrer">
      <div v-if="slide.imageUrl" class="display-shade"></div>
      <header><img v-if="storefront.logoUrl" :src="storefront.logoUrl" alt="" referrerpolicy="no-referrer"><strong>{{ storefront.name }}</strong><span>Order online · {{ fulfillmentLabel }}</span></header>
      <article><span>{{ slide.badge }}</span><h1>{{ slide.title }}</h1><p>{{ slide.description }}</p></article>
      <aside class="display-qr"><img :src="qrImage" alt="QR code for the online shop"><strong>Scan to order</strong><small>{{ shopUrl }}</small><a :href="shopUrl">Open menu</a></aside>
      <nav v-if="slides.length>1" aria-label="Promotions"><button class="display-carousel-toggle" :aria-label="carouselPaused ? 'Resume promotion carousel' : 'Pause promotion carousel'" @click="toggleCarousel">{{ carouselPaused ? 'Play' : 'Pause' }}</button><button v-for="(item,index) in slides" :key="item.id" :class="{active:index===active}" :aria-label="`Show ${item.title}`" @click="select(index)"></button></nav>
      <div class="display-actions"><button @click="printBanner">Print banner</button><button @click="downloadBanner">Download PNG</button></div>
      <p v-if="actionError" class="display-action-error" role="alert">{{ actionError }}</p>
    </section>
  </main>
</template>

<style scoped>
.customer-display{min-height:100dvh;background:#102b23;color:var(--display-ink);font-family:var(--display-font)}.display-state{min-height:100dvh;display:grid;place-content:center;justify-items:center;gap:12px;font-size:18px}.display-state strong{font-size:38px}.display-state button{border:0;border-radius:999px;padding:12px 20px}.display-slide{position:relative;min-height:100dvh;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) 370px;grid-template-rows:auto 1fr;gap:50px;padding:50px 64px}.display-backdrop,.display-shade{position:absolute;inset:0;width:100%;height:100%}.display-backdrop{object-fit:cover}.display-shade{background:linear-gradient(90deg,#0d201de8 0%,#0d201db5 48%,#0d201d47 100%)}header,article,.display-qr,nav,.display-actions,.display-action-error{position:relative;z-index:1}header{grid-column:1/-1;display:flex;align-items:center;gap:14px}header img{width:54px;height:54px;object-fit:contain;border-radius:10px;background:#fff}header strong{font-size:24px}header span{margin-left:auto;font-size:13px;letter-spacing:.1em;text-transform:uppercase}article{align-self:center;max-width:950px}article>span{color:var(--display-accent-readable);font-size:15px;letter-spacing:.18em;font-weight:800;text-transform:uppercase}h1{font:700 clamp(62px,8vw,136px)/.9 var(--display-font);letter-spacing:-.055em;margin:20px 0 28px}article p{max-width:780px;font-size:clamp(18px,2vw,28px);line-height:1.45;margin:0;opacity:.84}.display-qr{align-self:center;justify-self:end;width:340px;display:grid;justify-items:center;padding:28px;border-radius:24px;background:#fff;color:#17251f;box-shadow:0 30px 80px #0005}.display-qr img{width:270px;height:270px}.display-qr strong{font-size:28px;margin-top:15px}.display-qr small{max-width:100%;overflow:hidden;text-overflow:ellipsis;margin:7px 0 16px;font-size:11px}.display-qr a{border-radius:999px;padding:11px 19px;background:#17251f;color:#fff;text-decoration:none;font-weight:700;font-size:12px}nav{position:absolute;left:64px;bottom:40px;display:flex;gap:8px}nav button{width:30px;height:5px;border:0;border-radius:6px;background:currentColor;opacity:.35}nav button.active{width:58px;opacity:1}nav .display-carousel-toggle{width:auto;height:auto;padding:4px 9px;border:1px solid currentColor;background:#0d201d99;color:inherit;font:700 9px var(--display-font);letter-spacing:.06em;text-transform:uppercase;opacity:.8}.display-actions{position:absolute;right:64px;top:130px;display:flex;gap:8px;opacity:.35;transition:opacity .2s}.display-actions:hover,.display-actions:focus-within{opacity:1}.display-actions button{border:1px solid currentColor;border-radius:999px;background:#0d201d99;color:#fff;padding:9px 13px;font-size:10px}.display-action-error{position:absolute;right:64px;top:178px;max-width:420px;padding:10px 13px;border-radius:8px;background:#fff2ee;color:#813b29;font-size:11px}@media(max-width:900px){.display-slide{grid-template-columns:1fr;padding:30px}.display-qr{width:260px;justify-self:start}.display-qr img{width:190px;height:190px}nav{left:30px}.display-actions{right:30px;top:100px}.display-action-error{right:30px;top:148px}header span{display:none}}@page{size:A4 landscape;margin:0}@media print{.customer-display,.display-slide{-webkit-print-color-adjust:exact;print-color-adjust:exact}.display-actions,.display-action-error,nav{display:none}.customer-display,.display-slide{width:297mm;height:210mm;min-height:0}.display-slide{padding:18mm;grid-template-columns:1fr 75mm}.display-qr{width:68mm;padding:8mm}.display-qr img{width:54mm;height:54mm}h1{font-size:26mm}}
</style>
