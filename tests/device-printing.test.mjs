import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPrinterConnection,
  connectorUrl,
  discoverConnectorPrinters,
  escPosReceiptBytes,
  grantedPrinterSuggestion,
  normalizePrinterProfile,
  pairBluetoothPrinter,
  pairUsbPrinter,
  sendPrinterJob,
} from '../src/services/devicePrinting.js';
import { normalizeLabelOptions } from '../src/services/printing.js';

const job={version:2,type:'receipt',paperWidthMm:80,saleId:'sale-1',number:'POS-ABC123',lines:['MYFIN TEST','Total: RM 12.40']};

test('printer profiles keep hardware permission local and reject insecure remote connectors',()=>{
  assert.deepEqual(normalizePrinterProfile({transport:'usb',name:' Counter ',vendorId:'123',productId:456,serialNumber:' A '}),{
    version:1,transport:'usb',name:'Counter',vendorId:123,productId:456,serialNumber:'A',
  });
  assert.equal(connectorUrl('https://print.example.test/'),'https://print.example.test');
  assert.equal(connectorUrl('http://127.0.0.1:18181/'),'http://127.0.0.1:18181');
  assert.throws(()=>connectorUrl('http://192.168.1.20:18181/','https:'),/must use HTTPS/);
  assert.throws(()=>normalizePrinterProfile({transport:'bluetooth',serviceUuid:'not-a-uuid'}),/valid Bluetooth/);
});

test('exactly one previously authorized printer is auto-detected without opening a new permission chooser',()=>{
  const usb=normalizePrinterProfile({transport:'usb',name:'Android USB',vendorId:44,productId:55,serialNumber:'one'});
  assert.deepEqual(grantedPrinterSuggestion([usb],{transport:'browser'}),{kind:'single_granted',profile:usb});
  assert.equal(grantedPrinterSuggestion([usb,{transport:'bluetooth',deviceId:'two'}],{transport:'browser'}),null);
  assert.deepEqual(grantedPrinterSuggestion([usb],usb),{kind:'configured',profile:usb});
});

test('ESC/POS receipt bytes contain immutable receipt text, native QR data and a cutter command',()=>{
  const output=escPosReceiptBytes(job),text=new TextDecoder().decode(output);
  assert.ok(output instanceof Uint8Array);
  assert.match(text,/MYFIN TEST/);assert.match(text,/Total: RM 12.40/);assert.match(text,/POS-ABC123/);
  assert.deepEqual([...output.slice(-4)],[0x1d,0x56,0x41,0x03]);
});

test('an explicitly selected USB printer can receive a chunked receipt and reconnect without another picker',async()=>{
  const transfers=[];
  const device={vendorId:111,productId:222,serialNumber:'usb-a',productName:'USB Counter',opened:false,configuration:null,
    async open(){this.opened=true;},async selectConfiguration(){this.configuration={interfaces:[{interfaceNumber:2,alternates:[{alternateSetting:0,endpoints:[{direction:'out',endpointNumber:4}]}]}]};},
    async claimInterface(value){assert.equal(value,2);},async transferOut(endpoint,data){transfers.push({endpoint,data:[...data]});return {status:'ok',bytesWritten:data.length};}};
  let requests=0;const nav={usb:{async requestDevice(){requests++;return device;},async getDevices(){return [device];}}};
  const profile=await pairUsbPrinter(nav);
  await sendPrinterJob(profile,job,{navigator:nav});
  assert.equal(requests,1);assert.equal(profile.name,'USB Counter');assert.equal(transfers.length,1);assert.equal(transfers[0].endpoint,4);
});

test('USB printing rejects stalled or partial writes instead of reporting a false success',async()=>{
  const device={vendorId:112,productId:223,serialNumber:'usb-stall',productName:'USB Stall',opened:false,configuration:null,
    async open(){this.opened=true;},async selectConfiguration(){this.configuration={interfaces:[{interfaceNumber:1,alternates:[{alternateSetting:0,endpoints:[{direction:'out',endpointNumber:2}]}]}]};},
    async claimInterface(){},async transferOut(){return {status:'stall',bytesWritten:0};}};
  const nav={usb:{async requestDevice(){return device;},async getDevices(){return [device];}}};
  const profile=await pairUsbPrinter(nav);
  await assert.rejects(sendPrinterJob(profile,job,{navigator:nav}),/did not accept the complete receipt/);
});

test('clearing a detached USB handle forces the next print to enumerate and reopen the printer',async()=>{
  const makeDevice=label=>({vendorId:113,productId:224,serialNumber:'usb-reconnect',productName:label,opened:false,configuration:null,writes:0,
    async open(){this.opened=true;},async close(){this.opened=false;},async selectConfiguration(){this.configuration={interfaces:[{interfaceNumber:1,alternates:[{alternateSetting:0,endpoints:[{direction:'out',endpointNumber:2}]}]}]};},
    async claimInterface(){},async transferOut(_endpoint,data){this.writes++;return {status:'ok',bytesWritten:data.length};}});
  const detached=makeDevice('Detached USB'),replacement=makeDevice('Replacement USB');
  const nav={usb:{async requestDevice(){return detached;},async getDevices(){return [replacement];}}};
  const profile=await pairUsbPrinter(nav);
  clearPrinterConnection(profile);
  await sendPrinterJob(profile,job,{navigator:nav});
  assert.equal(detached.opened,false);assert.equal(detached.writes,0);assert.equal(replacement.writes,1);
});

test('BLE pairing writes in bounded chunks through an authorized GATT characteristic',async()=>{
  const writes=[];
  const characteristic={properties:{writeWithoutResponse:true},async writeValueWithoutResponse(value){writes.push(value.length);}};
  const service={async getCharacteristic(){return characteristic;},async getCharacteristics(){return [characteristic];}};
  const server={async getPrimaryService(){return service;}};
  const device={id:'ble-a',name:'BLE Counter',gatt:{connected:false,async connect(){this.connected=true;return server;}}};
  const nav={bluetooth:{async requestDevice(options){assert.equal(options.acceptAllDevices,true);return device;},async getDevices(){return [device];}}};
  const profile=await pairBluetoothPrinter({},nav);
  await sendPrinterJob(profile,{...job,lines:[...job.lines,'x'.repeat(500)]},{navigator:nav});
  assert.equal(profile.deviceId,'ble-a');assert.ok(writes.length>=3);assert.ok(writes.every(size=>size<=180));
});

test('network connector discovery and printing use an explicit printer id and bounded JSON contract',async()=>{
  const calls=[];const fetch=async(url,options)=>{calls.push({url,options});return url.endsWith('/v1/printers')
    ?{ok:true,json:async()=>({printers:[{id:'kitchen-1',name:'Kitchen',status:'ready',media:'60x40',capabilities:['label']}]})}
    :{ok:true,json:async()=>({accepted:true,jobId:'print-1'})};};
  const printers=await discoverConnectorPrinters('https://print.example.test',{fetch});
  assert.deepEqual(printers,[{id:'kitchen-1',name:'Kitchen',status:'ready',media:'60x40',capabilities:['label']}]);
  await sendPrinterJob({transport:'connector',url:'https://print.example.test',printerId:'kitchen-1',name:'Kitchen'},job,{fetch});
  const body=JSON.parse(calls[1].options.body);
  assert.equal(body.printerId,'kitchen-1');assert.equal(body.format,'escpos');assert.equal(body.job.saleId,'sale-1');assert.ok(body.payloadBase64.length>40);
  const profile={transport:'connector',url:'https://print.example.test',printerId:'kitchen-1',name:'Kitchen'};
  await assert.rejects(sendPrinterJob(profile,job,{fetch:async()=>({ok:true,json:async()=>({})})}),/did not confirm/);
  await assert.rejects(sendPrinterJob(profile,job,{fetch:async()=>({ok:true,json:async()=>{throw Error('bad json');}})}),/did not confirm/);
});

test('label presets retain a scannable code while bounding user design values',()=>{
  assert.deepEqual(normalizeLabelOptions({design:'retail',accent:'#123abc',subtitle:' Fresh\ncoffee ',showPrice:false}),{
    design:'retail',accent:'#123ABC',subtitle:'Fresh coffee',showPrice:false,showName:true,
  });
  assert.equal(normalizeLabelOptions({design:'unknown',accent:'red'}).design,'classic');
});
