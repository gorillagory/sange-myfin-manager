import { receiptPrintJob } from '../domain/receipt.js';

const encoder = new TextEncoder();
const DEFAULT_BLUETOOTH_SERVICES = Object.freeze([
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
]);
const DEFAULT_BLUETOOTH_CHARACTERISTICS = Object.freeze([
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
]);
const connections = new Map();

const clean = (value, maximum = 200) => String(value ?? '').trim().slice(0, maximum);
const integer = value => Number.isSafeInteger(Number(value)) ? Number(value) : null;
const keyFor = profile => `${profile.transport}:${profile.serialNumber || profile.deviceId || profile.url || ''}:${profile.printerId || ''}`;

function uuid(value) {
  value = clean(value, 64).toLowerCase();
  if (!value) return '';
  if (!/^(?:0x[0-9a-f]{4}|[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value))
    throw new Error('Use a valid Bluetooth service or characteristic UUID.');
  return value;
}

export function connectorUrl(value, pageProtocol = globalThis.location?.protocol || 'https:') {
  const text = clean(value, 500).replace(/\/+$/, '');
  if (!text) throw new Error('Enter the HTTPS address of the MyFin print connector.');
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error('Enter a valid print connector URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
    throw new Error('The print connector must use HTTPS. A loopback connector may use HTTP on localhost.');
  if (pageProtocol === 'https:' && parsed.protocol === 'http:' && !local)
    throw new Error('An HTTPS POS cannot send receipts to an insecure network connector.');
  parsed.username = ''; parsed.password = ''; parsed.hash = ''; parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizePrinterProfile(raw = {}, options = {}) {
  const transport = ['browser', 'usb', 'bluetooth', 'connector'].includes(raw.transport) ? raw.transport : 'browser';
  const profile = { version:1,transport,name:clean(raw.name || (transport === 'browser' ? 'System print dialog' : ''),120) };
  if (transport === 'usb') {
    profile.vendorId = integer(raw.vendorId);
    profile.productId = integer(raw.productId);
    profile.serialNumber = clean(raw.serialNumber,160);
  } else if (transport === 'bluetooth') {
    profile.deviceId = clean(raw.deviceId,200);
    profile.serviceUuid = uuid(raw.serviceUuid);
    profile.characteristicUuid = uuid(raw.characteristicUuid);
  } else if (transport === 'connector') {
    profile.url = connectorUrl(raw.url, options.pageProtocol);
    profile.printerId = clean(raw.printerId,160);
    if (!profile.printerId) throw new Error('Choose a printer reported by the connector.');
  }
  return profile;
}

export function printerCapabilities(nav = globalThis.navigator, secure = globalThis.isSecureContext !== false) {
  return {
    browser:true,
    usb:Boolean(secure && nav?.usb?.requestDevice && nav?.usb?.getDevices),
    bluetooth:Boolean(secure && nav?.bluetooth?.requestDevice),
    bluetoothReconnect:Boolean(secure && nav?.bluetooth?.getDevices),
    connector:Boolean(globalThis.fetch),
  };
}

export function printerPlatformNotes(capabilities = printerCapabilities()) {
  return {
    usb: capabilities.usb
      ? 'Supported here. The first connection always needs a user tap and the browser device picker.'
      : 'WebUSB is unavailable in this browser. Use current Chrome/Edge on Android, Windows, macOS or Linux, or use the print connector.',
    bluetooth: capabilities.bluetooth
      ? 'BLE printers can connect after a user tap. Bluetooth Classic printers need an Android/vendor driver or the print connector.'
      : 'Web Bluetooth is unavailable here. Pair the printer with the operating system and use the browser dialog, or use the print connector.',
    connector: 'Wi-Fi/Ethernet printers need an HTTPS MyFin print connector on the same site or terminal; browsers cannot discover or open raw port 9100 themselves.',
  };
}

function usbProfile(device) {
  return normalizePrinterProfile({
    transport:'usb',name:device.productName || `USB printer ${device.vendorId}:${device.productId}`,
    vendorId:device.vendorId,productId:device.productId,serialNumber:device.serialNumber || '',
  });
}

function bluetoothProfile(device, hints = {}) {
  return normalizePrinterProfile({
    transport:'bluetooth',name:device.name || 'Bluetooth printer',deviceId:device.id,
    serviceUuid:hints.serviceUuid || '',characteristicUuid:hints.characteristicUuid || '',
  });
}

export async function grantedPrinters(nav = globalThis.navigator) {
  const result = [];
  if (nav?.usb?.getDevices) for (const device of await nav.usb.getDevices()) result.push(usbProfile(device));
  if (nav?.bluetooth?.getDevices) for (const device of await nav.bluetooth.getDevices()) result.push(bluetoothProfile(device));
  return result;
}

export function grantedPrinterSuggestion(known = [], current = {}) {
  const profiles = known.filter(row=>row?.transport==='usb'||row?.transport==='bluetooth');
  const match = profiles.find(row=>row.transport===current?.transport&&(
    row.transport==='usb'
      ? row.vendorId===integer(current.vendorId)&&row.productId===integer(current.productId)&&(!current.serialNumber||row.serialNumber===clean(current.serialNumber,160))
      : row.deviceId===clean(current.deviceId,200)
  ));
  if (match) return {kind:'configured',profile:match};
  if ((!current?.transport||current.transport==='browser')&&profiles.length===1) return {kind:'single_granted',profile:profiles[0]};
  return null;
}

export async function pairUsbPrinter(nav = globalThis.navigator) {
  if (!printerCapabilities(nav).usb) throw new Error('WebUSB is not available in this browser.');
  const device = await nav.usb.requestDevice({ filters:[] });
  const profile = usbProfile(device);
  await openUsbDevice(profile,device);
  return profile;
}

export async function pairBluetoothPrinter(hints = {}, nav = globalThis.navigator) {
  if (!printerCapabilities(nav).bluetooth) throw new Error('Web Bluetooth is not available in this browser.');
  const serviceUuid = uuid(hints.serviceUuid), characteristicUuid = uuid(hints.characteristicUuid);
  const optionalServices = [...new Set([serviceUuid,...DEFAULT_BLUETOOTH_SERVICES].filter(Boolean))];
  const device = await nav.bluetooth.requestDevice({ acceptAllDevices:true,optionalServices });
  const profile = bluetoothProfile(device,{serviceUuid,characteristicUuid});
  const server = await device.gatt.connect();
  const characteristic = await findBluetoothCharacteristic(server,profile);
  connections.set(keyFor(profile),{device,characteristic});
  return profile;
}

function sameUsb(device, profile) {
  return Number(device.vendorId) === profile.vendorId && Number(device.productId) === profile.productId &&
    (!profile.serialNumber || device.serialNumber === profile.serialNumber);
}

async function connectUsb(profile, nav = globalThis.navigator) {
  const key = keyFor(profile);
  if (connections.get(key)?.device?.opened) return connections.get(key);
  const devices = await nav?.usb?.getDevices?.() || [];
  const device = devices.find(item => sameUsb(item,profile));
  if (!device) throw new Error('This USB printer is not authorized on this device. Pair it again from Device / Printing.');
  return openUsbDevice(profile,device);
}

async function openUsbDevice(profile,device) {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const interfaces = device.configuration?.interfaces || [];
  let selected;
  for (const face of interfaces) for (const alternate of face.alternates || []) {
    const endpoint = (alternate.endpoints || []).find(item => item.direction === 'out');
    if (endpoint) { selected = { interfaceNumber:face.interfaceNumber,alternateSetting:alternate.alternateSetting,endpointNumber:endpoint.endpointNumber }; break; }
  }
  if (!selected) throw new Error('The selected USB device does not expose a writable printer endpoint. Install its driver or use the print connector.');
  await device.claimInterface(selected.interfaceNumber);
  if (selected.alternateSetting) await device.selectAlternateInterface(selected.interfaceNumber,selected.alternateSetting);
  const connection = { device,...selected };
  connections.set(keyFor(profile),connection);
  return connection;
}

async function findBluetoothCharacteristic(server, profile) {
  const serviceIds = [...new Set([profile.serviceUuid,...DEFAULT_BLUETOOTH_SERVICES].filter(Boolean))];
  const characteristicIds = [...new Set([profile.characteristicUuid,...DEFAULT_BLUETOOTH_CHARACTERISTICS].filter(Boolean))];
  for (const serviceId of serviceIds) {
    try {
      const service = await server.getPrimaryService(serviceId);
      if (profile.characteristicUuid) {
        try { return await service.getCharacteristic(profile.characteristicUuid); } catch { /* Try known writable characteristics below. */ }
      }
      for (const characteristicId of characteristicIds) {
        try {
          const characteristic = await service.getCharacteristic(characteristicId);
          if (characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) return characteristic;
        } catch { /* Continue through known printer characteristics. */ }
      }
      for (const characteristic of await service.getCharacteristics())
        if (characteristic.properties?.write || characteristic.properties?.writeWithoutResponse) return characteristic;
    } catch { /* Printer does not expose this known service. */ }
  }
  throw new Error('No writable BLE printer service was found. Enter the service and characteristic UUID from the printer manual. Bluetooth Classic is not available through Web Bluetooth.');
}

async function connectBluetooth(profile, nav = globalThis.navigator) {
  const key = keyFor(profile), cached = connections.get(key);
  if (cached?.device?.gatt?.connected) return cached;
  const devices = await nav?.bluetooth?.getDevices?.() || [];
  const device = devices.find(item => item.id === profile.deviceId);
  if (!device) throw new Error('This Bluetooth printer is not authorized on this device. Pair it again from Device / Printing.');
  const server = await device.gatt.connect();
  const characteristic = await findBluetoothCharacteristic(server,profile);
  const connection = { device,characteristic };
  connections.set(key,connection);
  return connection;
}

export async function discoverConnectorPrinters(value, dependencies = {}) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const url = connectorUrl(value, dependencies.pageProtocol);
  const response = await fetcher(`${url}/v1/printers`,{ method:'GET',headers:{ Accept:'application/json' },signal:dependencies.signal });
  if (!response.ok) throw new Error(`The print connector returned HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.printers)) throw new Error('The print connector response is invalid.');
  return body.printers.slice(0,100).map(row => ({
    id:clean(row.id,160),name:clean(row.name || row.id,120),status:['ready','offline','error'].includes(row.status)?row.status:'unknown',
    media:clean(row.media,80),capabilities:Array.isArray(row.capabilities)?row.capabilities.map(value=>clean(value,40)).filter(Boolean).slice(0,20):[],
  })).filter(row=>row.id);
}

const bytes = (...values) => Uint8Array.from(values);
const concat = arrays => {
  const output = new Uint8Array(arrays.reduce((sum,array)=>sum+array.length,0));
  let offset = 0; for (const array of arrays) { output.set(array,offset); offset += array.length; }
  return output;
};
const ascii = value => encoder.encode(String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E\n]/g,'?'));
function qrCommands(value) {
  const data = ascii(value), storeLength = data.length + 3;
  return concat([
    bytes(0x1d,0x28,0x6b,0x04,0x00,0x31,0x41,0x32,0x00),
    bytes(0x1d,0x28,0x6b,0x03,0x00,0x31,0x43,0x06),
    bytes(0x1d,0x28,0x6b,0x03,0x00,0x31,0x45,0x31),
    bytes(0x1d,0x28,0x6b,storeLength&0xff,(storeLength>>8)&0xff,0x31,0x50,0x30),data,
    bytes(0x1d,0x28,0x6b,0x03,0x00,0x31,0x51,0x30),
  ]);
}

export function escPosReceiptBytes(job, { includeQr=true,cut=true } = {}) {
  if (!job || job.type !== 'receipt' || !Array.isArray(job.lines)) throw new Error('A valid saved receipt print job is required.');
  const chunks = [bytes(0x1b,0x40),bytes(0x1b,0x61,0x00),ascii(job.lines.join('\n')+'\n')];
  if (includeQr && job.number) chunks.push(bytes(0x1b,0x61,0x01),qrCommands(job.number),ascii('\n'));
  chunks.push(ascii('\n\n'));
  if (cut) chunks.push(bytes(0x1d,0x56,0x41,0x03));
  return concat(chunks);
}

async function writeChunks(bytesToWrite, size, write) {
  for (let offset=0;offset<bytesToWrite.length;offset+=size) await write(bytesToWrite.slice(offset,offset+size));
}

export async function sendPrinterJob(rawProfile, job, dependencies = {}) {
  const profile = normalizePrinterProfile(rawProfile,{pageProtocol:dependencies.pageProtocol});
  if (profile.transport === 'browser') return { transport:'browser',browserDialog:true };
  const payload = escPosReceiptBytes(job,dependencies.escPosOptions);
  if (profile.transport === 'usb') {
    const connection = await connectUsb(profile,dependencies.navigator || globalThis.navigator);
    await writeChunks(payload,4096,async chunk=>{
      const result=await connection.device.transferOut(connection.endpointNumber,chunk);
      if(result?.status!=='ok'||result?.bytesWritten!==chunk.length)
        throw new Error('The USB printer did not accept the complete receipt. Reconnect it and try again.');
    });
  } else if (profile.transport === 'bluetooth') {
    const connection = await connectBluetooth(profile,dependencies.navigator || globalThis.navigator);
    const write = connection.characteristic.properties?.writeWithoutResponse && connection.characteristic.writeValueWithoutResponse
      ? chunk=>connection.characteristic.writeValueWithoutResponse(chunk)
      : chunk=>connection.characteristic.writeValue(chunk);
    await writeChunks(payload,180,write);
  } else {
    const fetcher = dependencies.fetch || globalThis.fetch;
    const response = await fetcher(`${profile.url}/v1/print`,{
      method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({version:1,printerId:profile.printerId,format:'escpos',job,payloadBase64:toBase64(payload)}),
      signal:dependencies.signal,
    });
    if (!response.ok) throw new Error(`The print connector rejected the job (HTTP ${response.status}).`);
    const body = await response.json().catch(()=>null);
    if (!body || body.accepted !== true)
      throw new Error(clean(body?.message,200) || 'The print connector did not confirm the job.');
  }
  return { transport:profile.transport,printed:true };
}

function toBase64(value) {
  let binary=''; for(let i=0;i<value.length;i+=0x8000) binary+=String.fromCharCode(...value.subarray(i,i+0x8000));
  return globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(value).toString('base64');
}

export function testReceiptJob(width = '80') {
  return {version:2,type:'receipt',paperWidthMm:String(width)==='58'?58:80,saleId:'test',number:'MYFIN-TEST',lines:[
    'MYFIN PRINTER TEST','Connection ready',new Date().toISOString(),'------------------------','RM 1.00','',
  ]};
}

export async function printSavedReceipt(sale, paperWidth, profile, dependencies = {}) {
  return sendPrinterJob(profile,receiptPrintJob(sale,paperWidth),dependencies);
}

export async function testConfiguredPrinter(profile, paperWidth = '80', dependencies = {}) {
  return sendPrinterJob(profile,testReceiptJob(paperWidth),dependencies);
}

export function clearPrinterConnection(profile) {
  const normalized = normalizePrinterProfile(profile);
  const connection = connections.get(keyFor(normalized));
  try { connection?.device?.gatt?.disconnect?.(); } catch { /* Best-effort local disconnect. */ }
  try { connection?.device?.close?.(); } catch { /* Best-effort local disconnect. */ }
  connections.delete(keyFor(normalized));
}
