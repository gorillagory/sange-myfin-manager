<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../../ui/EditionIcon.vue';
import {
  clearPrinterConnection,
  discoverConnectorPrinters,
  grantedPrinterSuggestion,
  grantedPrinters,
  normalizePrinterProfile,
  pairBluetoothPrinter,
  pairUsbPrinter,
  printerCapabilities,
  printerPlatformNotes,
  testConfiguredPrinter,
} from '../../../services/devicePrinting';

const props=defineProps({modelValue:{type:Object,default:()=>({transport:'browser'})},paperWidth:{type:String,default:'80'}});
const emit=defineEmits(['update:modelValue']);
const transport=ref(props.modelValue?.transport||'browser'),busy=ref(false),error=ref(''),status=ref('');
const serviceUuid=ref(props.modelValue?.serviceUuid||''),characteristicUuid=ref(props.modelValue?.characteristicUuid||'');
const connector=ref(props.modelValue?.url||''),connectorPrinters=ref([]),connectorPrinterId=ref(props.modelValue?.printerId||'');
const knownPrinters=ref([]);
const capabilities=printerCapabilities(),notes=printerPlatformNotes(capabilities);
const configured=computed(()=>props.modelValue?.transport&&props.modelValue.transport!=='browser');
const selectedConnector=computed(()=>connectorPrinters.value.find(row=>row.id===connectorPrinterId.value));

watch(()=>props.modelValue,value=>{
  transport.value=value?.transport||'browser';
  if(value?.transport==='bluetooth'){serviceUuid.value=value.serviceUuid||'';characteristicUuid.value=value.characteristicUuid||'';}
  if(value?.transport==='connector'){connector.value=value.url||'';connectorPrinterId.value=value.printerId||'';}
});

function choose(value){
  if(value!==transport.value&&['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);
  transport.value=value;error.value='';status.value='';
  if(value==='browser')emit('update:modelValue',normalizePrinterProfile({transport:'browser'}));
}
async function pairUsb(){
  busy.value=true;error.value='';status.value='';
  try{if(['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);const profile=await pairUsbPrinter();emit('update:modelValue',profile);transport.value='usb';status.value=`Connected to ${profile.name}. Save changes to remember it on this terminal.`;}
  catch(failure){error.value=failure.name==='NotFoundError'?'No USB printer was selected.':failure.message;}
  finally{busy.value=false;}
}
async function pairBluetooth(){
  busy.value=true;error.value='';status.value='';
  try{if(['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);const profile=await pairBluetoothPrinter({serviceUuid:serviceUuid.value,characteristicUuid:characteristicUuid.value});emit('update:modelValue',profile);transport.value='bluetooth';status.value=`Connected to ${profile.name}. Save changes to remember it on this terminal.`;}
  catch(failure){error.value=failure.name==='NotFoundError'?'No Bluetooth printer was selected.':failure.message;}
  finally{busy.value=false;}
}
async function discoverConnector(){
  busy.value=true;error.value='';status.value='';connectorPrinters.value=[];
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
  try{
    connectorPrinters.value=await discoverConnectorPrinters(connector.value,{signal:controller.signal});
    if(!connectorPrinters.value.length)throw new Error('The connector is online but reported no printers.');
    if(!connectorPrinters.value.some(row=>row.id===connectorPrinterId.value))connectorPrinterId.value=connectorPrinters.value.find(row=>row.status==='ready')?.id||connectorPrinters.value[0].id;
    applyConnector();status.value=`Found ${connectorPrinters.value.length} printer${connectorPrinters.value.length===1?'':'s'}.`;
  }catch(failure){error.value=failure.name==='AbortError'?'The print connector did not answer within 7 seconds.':failure.message;}
  finally{clearTimeout(timer);busy.value=false;}
}
function applyConnector(){
  try{
    const row=selectedConnector.value;
    const profile=normalizePrinterProfile({transport:'connector',url:connector.value,printerId:connectorPrinterId.value,name:row?.name||props.modelValue?.name||'Network printer'});
    if(['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);
    emit('update:modelValue',profile);error.value='';
  }catch(failure){error.value=failure.message;}
}
async function test(){
  if(!configured.value){error.value='Choose and connect a printer first.';return;}
  busy.value=true;error.value='';status.value='';
  try{await testConfiguredPrinter(props.modelValue,props.paperWidth);status.value='Test receipt sent. Check the printer before saving.';}
  catch(failure){error.value=failure.message||'The printer did not accept the test receipt.';}
  finally{busy.value=false;}
}
async function detectGranted(){
  try{
    const known=await grantedPrinters();knownPrinters.value=known;
    const current=props.modelValue||{};
    const suggestion=grantedPrinterSuggestion(known,current);
    if(suggestion?.kind==='configured')status.value=`${suggestion.profile.name} is authorized on this terminal and will reconnect when you print.`;
    else if(suggestion?.kind==='single_granted'){
      emit('update:modelValue',suggestion.profile);transport.value=suggestion.profile.transport;
      status.value=`Detected the previously authorized ${suggestion.profile.name}. Save changes to use it for receipts on this terminal.`;
    }
  }catch{/* Detection is informative; printing still reports a concrete failure. */}
}
function useKnown(profile){if(['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);emit('update:modelValue',profile);transport.value=profile.transport;status.value=`Selected ${profile.name}. Save changes to use it for receipts.`;error.value='';}
function usbChanged(event){
  if(event?.type==='disconnect'&&props.modelValue?.transport==='usb'&&event.device?.vendorId===props.modelValue.vendorId&&event.device?.productId===props.modelValue.productId){
    clearPrinterConnection(props.modelValue);
    status.value='The saved USB printer was disconnected. Reconnect its cable before printing.';
  }else detectGranted();
}
onMounted(()=>{detectGranted();navigator.usb?.addEventListener?.('connect',usbChanged);navigator.usb?.addEventListener?.('disconnect',usbChanged);});
onBeforeUnmount(()=>{navigator.usb?.removeEventListener?.('connect',usbChanged);navigator.usb?.removeEventListener?.('disconnect',usbChanged);if(['usb','bluetooth'].includes(props.modelValue?.transport))clearPrinterConnection(props.modelValue);});
</script>

<template>
  <section class="mf-printer-setup">
    <div class="mf-printer-title"><div><h3>Receipt printer connection</h3><p class="ed-muted">Printer permission is local to this terminal. Receipts never leave the device except through the connector you configure.</p></div><span class="ed-pill" :class="{ready:configured}">{{ configured?'Configured':'Browser dialog' }}</span></div>
    <div class="mf-printer-transports" role="radiogroup" aria-label="Printer connection">
      <button v-for="item in [{id:'browser',label:'System dialog',detail:'Any installed printer'},{id:'usb',label:'USB',detail:'Chrome / Edge'},{id:'bluetooth',label:'Bluetooth LE',detail:'BLE printers'},{id:'connector',label:'Wi-Fi / Ethernet',detail:'MyFin connector'}]" :key="item.id" type="button" :class="{active:transport===item.id}" role="radio" :aria-checked="transport===item.id" @click="choose(item.id)"><Icon :name="item.id==='connector'?'cloud':'printer'"/><span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span></button>
    </div>
    <div v-if="transport==='browser'" class="ed-notice"><Icon name="printer"/><div><strong>Works with printers installed in this device.</strong>The operating-system print dialog chooses USB, Bluetooth, Wi-Fi or Ethernet. Browsers do not reveal installed printer names to a website.</div></div>
    <div v-else-if="transport==='usb'" class="mf-printer-panel">
      <p>{{ notes.usb }}</p><div v-if="modelValue.transport==='usb'" class="mf-printer-current"><Icon name="check"/><span><strong>{{ modelValue.name }}</strong><small>USB {{ modelValue.vendorId }}:{{ modelValue.productId }}<template v-if="modelValue.serialNumber"> · {{ modelValue.serialNumber }}</template></small></span></div>
      <button class="ed-btn" :disabled="busy||!capabilities.usb" @click="pairUsb"><Icon name="printer"/>{{ modelValue.transport==='usb'?'Replace USB printer':'Choose USB printer' }}</button>
    </div>
    <div v-else-if="transport==='bluetooth'" class="mf-printer-panel">
      <p>{{ notes.bluetooth }}</p><div class="ed-form-grid"><label class="ed-field"><span>Service UUID (optional)</span><input v-model.trim="serviceUuid" maxlength="64" placeholder="From printer manual"></label><label class="ed-field"><span>Write characteristic UUID (optional)</span><input v-model.trim="characteristicUuid" maxlength="64" placeholder="From printer manual"></label></div>
      <div v-if="modelValue.transport==='bluetooth'" class="mf-printer-current"><Icon name="check"/><span><strong>{{ modelValue.name }}</strong><small>Bluetooth LE · authorized on this terminal</small></span></div>
      <button class="ed-btn" :disabled="busy||!capabilities.bluetooth" @click="pairBluetooth"><Icon name="printer"/>{{ modelValue.transport==='bluetooth'?'Replace BLE printer':'Choose BLE printer' }}</button>
    </div>
    <div v-else class="mf-printer-panel">
      <p>{{ notes.connector }}</p><div class="ed-form-grid"><label class="ed-field wide"><span>Connector address</span><input v-model.trim="connector" type="url" maxlength="500" placeholder="https://print-counter.example.lan"></label><label v-if="connectorPrinters.length" class="ed-field wide"><span>Printer</span><select v-model="connectorPrinterId" @change="applyConnector"><option v-for="row in connectorPrinters" :key="row.id" :value="row.id">{{ row.name }} · {{ row.status }}<template v-if="row.media"> · {{ row.media }}</template></option></select></label></div>
      <button class="ed-btn" :disabled="busy||!connector" @click="discoverConnector"><Icon name="search"/>Discover connector printers</button>
    </div>
    <div v-if="configured" class="ed-actions mf-printer-test"><button class="ed-btn" :disabled="busy" @click="test"><Icon name="receipt"/>{{ busy?'Connecting…':'Print test receipt' }}</button><small>MyFin reconnects an already-authorized printer when a receipt is sent. A new USB/Bluetooth permission can never be requested silently.</small></div>
    <div v-if="!configured&&knownPrinters.length>1" class="mf-printer-known"><strong>Authorized printers on this terminal</strong><button v-for="profile in knownPrinters" :key="`${profile.transport}:${profile.serialNumber||profile.deviceId}`" type="button" class="ed-btn" @click="useKnown(profile)"><Icon name="printer"/>Use {{ profile.name }}</button></div>
    <p v-if="status" class="ed-notice" role="status"><Icon name="check"/><span>{{ status }}</span></p><p v-if="error" class="ed-notice error" role="alert"><Icon name="alert"/><span>{{ error }}</span></p>
  </section>
</template>

<style scoped>
.mf-printer-setup{margin-top:24px;padding-top:24px;border-top:1px solid var(--ed-line)}.mf-printer-title{display:flex;align-items:start;justify-content:space-between;gap:16px}.mf-printer-title h3{margin:0 0 5px}.mf-printer-title p{margin:0}.mf-printer-transports{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:18px 0}.mf-printer-transports button{display:flex;align-items:center;gap:10px;min-height:68px;padding:11px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-paper);color:var(--ed-ink);text-align:left}.mf-printer-transports button.active{border-color:var(--ed-accent);box-shadow:inset 0 0 0 1px var(--ed-accent);background:var(--ed-tint)}.mf-printer-transports span,.mf-printer-transports strong,.mf-printer-transports small{display:block;min-width:0}.mf-printer-transports small,.mf-printer-panel p,.mf-printer-test small,.mf-printer-current small{color:var(--ed-muted);font-size:10px;line-height:1.5}.mf-printer-panel{display:grid;gap:14px;padding:18px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:color-mix(in srgb,var(--ed-paper) 90%,var(--ed-tint))}.mf-printer-panel p{margin:0}.mf-printer-panel>.ed-btn{justify-self:start}.mf-printer-current{display:flex;align-items:center;gap:10px}.mf-printer-current .ed-icon{color:var(--ed-success,#16734b)}.mf-printer-current span,.mf-printer-current strong,.mf-printer-current small{display:block}.mf-printer-test{align-items:center;margin-top:14px}.mf-printer-test small{max-width:470px}.mf-printer-known{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px;padding:12px;border:1px solid var(--ed-line);border-radius:var(--ed-radius)}.mf-printer-known>strong{width:100%;font-size:11px}@media(max-width:850px){.mf-printer-transports{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.mf-printer-transports{grid-template-columns:1fr}.mf-printer-title{display:block}.mf-printer-title .ed-pill{margin-top:8px}}
</style>
