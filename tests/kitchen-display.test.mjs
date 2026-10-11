import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  findKitchenTicket,
  kitchenLabelCode,
  kitchenStations,
  kitchenStickerLines,
  kitchenTicket,
  kitchenTickets,
} from '../src/domain/kitchenOrders.js';
import { canVisit } from '../src/domain/viewAccess.js';

const products = [
  { id:'latte', category:'Menu', subcategory:'Coffee' },
  { id:'croissant', category:'Pastry', subcategory:'' },
];
const request = { id:'request-a', code:'A-104', status:'accepted', version:2, guestName:'Amin',
  serviceMode:'table', location:{ name:'Table 7' }, createdAt:'2026-10-11T02:00:00.000Z', items:[
    { productId:'latte', description:'Latte', quantity:2 },
    { productId:'croissant', description:'Croissant', quantity:.5, unit:'tray' },
  ] };
const paid = { id:'sale-a', number:'POS-105', status:'preparing', version:3,
  customerName:'Walk-in customer', createdAt:'2026-10-11T02:01:00.000Z', items:[
    { productId:'latte', description:'Americano', qty:1 },
  ] };

test('kitchen tickets map durable request and paid states into three operational lanes', () => {
  const unpaid = kitchenTicket(request,'request',products);
  assert.deepEqual({ lane:unpaid.lane,next:unpaid.nextStatus,payment:unpaid.paymentLabel,source:unpaid.source },
    { lane:'pending',next:'preparing',payment:'Pay at counter',source:'Table 7' });
  const fulfillment = kitchenTicket(paid,'paid',products);
  assert.deepEqual({ lane:fulfillment.lane,next:fulfillment.nextStatus,payment:fulfillment.paymentLabel },
    { lane:'preparing',next:'ready',payment:'Paid' });
  assert.equal(kitchenTicket({ ...request,status:'submitted' },'request',products),null);
  assert.equal(kitchenTicket({ ...paid,status:'completed' },'paid',products),null);
});

test('station and text filters retain mixed-station tickets and order oldest work first', () => {
  assert.deepEqual(kitchenStations({ requests:[request],paid:[paid],products }),['Coffee','Pastry']);
  assert.deepEqual(kitchenTickets({ requests:[request],paid:[paid],products,station:'Pastry' }).map(row=>row.code),['A-104']);
  assert.deepEqual(kitchenTickets({ requests:[request],paid:[paid],products,query:'americano' }).map(row=>row.code),['POS-105']);
});

test('printed QR payload and keyboard-wedge input identify one active order exactly', () => {
  const tickets = kitchenTickets({ requests:[request],paid:[paid],products });
  const code = kitchenLabelCode(tickets[0]);
  assert.equal(findKitchenTicket(tickets,code)?.key,tickets[0].key);
  assert.equal(findKitchenTicket(tickets,'pos-105')?.id,'sale-a');
  assert.equal(findKitchenTicket(tickets,'105'),null);
});

test('item sticker copies follow whole quantities, preserve measured quantities and stay bounded', () => {
  const ticket = kitchenTicket(request,'request',products);
  assert.deepEqual(kitchenStickerLines(ticket).map(row => [row.description,row.copy,row.copies]),[
    ['Latte',1,2],['Latte',2,2],['Croissant',1,1],
  ]);
  assert.equal(kitchenStickerLines({ items:[{ description:'Bulk',quantity:500 }] },25).length,25);
});

test('every active staff role can open the dedicated kitchen route from a second device', async () => {
  for (const role of ['operator','manager','workspace_owner','super_admin'])
    assert.equal(canVisit({ role },'/kitchen'),true);
  assert.equal(canVisit({ role:'suspended' },'/kitchen'),false);
  const [router,shell,display] = await Promise.all([
    readFile(new URL('../src/router/index.js',import.meta.url),'utf8'),
    readFile(new URL('../src/components/EditionShell.vue',import.meta.url),'utf8'),
    readFile(new URL('../src/components/dashboard/KitchenDisplay.vue',import.meta.url),'utf8'),
  ]);
  assert.match(router,/path: '\/kitchen'[\s\S]*KitchenDisplay\.vue/);
  assert.match(shell,/\['\/kitchen','Kitchen Display','printer'\]/);
  assert.match(display,/await import\('@zxing\/browser'\)/);
  assert.match(display,/facingMode:\{ ideal:'environment' \}/);
  assert.match(display,/scanControls\?\.stop\(\)/);
  assert.match(display,/srcObject\?\.getTracks/);
});
