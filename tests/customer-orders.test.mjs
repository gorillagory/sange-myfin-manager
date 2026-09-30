import test from 'node:test';
import assert from 'node:assert/strict';
import {
  customerOrderActions,
  customerOrderCart,
  customerOrderCounts,
  customerOrderCustomer,
  customerOrderStatusLabel,
  customerOrderTenderMatches,
  isTenderableCustomerOrder,
  validCustomerOrderCart,
} from '../src/domain/customerOrders.js';

test('customer request state exposes only safe staff transitions', () => {
  assert.deepEqual(customerOrderActions({ status:'awaiting_acceptance' }), ['accepted','cancelled','expired']);
  assert.deepEqual(customerOrderActions({ status:'accepted' }), ['preparing','cancelled','expired']);
  assert.deepEqual(customerOrderActions({ status:'preparing' }), ['ready','cancelled','expired']);
  assert.deepEqual(customerOrderActions({ status:'ready' }), ['cancelled','expired']);
  assert.deepEqual(customerOrderActions({ status:'paid', paymentStatus:'paid' }), []);
  assert.equal(isTenderableCustomerOrder({ status:'awaiting_acceptance' }), false);
  assert.equal(isTenderableCustomerOrder({ status:'ready', paymentStatus:'unpaid' }), true);
  assert.equal(customerOrderStatusLabel('ready'), 'Ready for collection');
});

test('counter tender must match every accepted quote total', () => {
  const totals={subtotal:17,discountAmount:0,discount:0,tax:1.02,taxRate:6,totalBeforeRounding:18.02,rounding:-0.02,total:18};
  assert.equal(customerOrderTenderMatches({...totals},totals),true);
  assert.equal(customerOrderTenderMatches({...totals,tax:1.36,taxRate:8,total:18.35},totals),false);
});

test('summary counts preserve explicit active and derive it when absent', () => {
  assert.deepEqual(customerOrderCounts({ counts:{ active:7, submitted:2, ready:1 } }), {
    active:7, submitted:2, accepted:0, preparing:0, ready:1, paid:0,
  });
  assert.equal(customerOrderCounts({ submitted:2, accepted:1, preparing:3, ready:1 }).active, 7);
});

test('server order snapshots become a validated POS cart and customer', () => {
  const order = { customerName:'Guest 42', customerEmail:'guest@example.test', items:[
    { product_id:'latte', variant_id:'large', description:'Latte', variantName:'Large', quantity:'2', unitPrice:'12.5', unit:'cup' },
  ] };
  const cart = customerOrderCart(order);
  assert.deepEqual(cart, [{ productId:'latte', variantId:'large', desc:'Latte', variant:'Large', unit:'cup', qty:2, price:12.5 }]);
  assert.equal(validCustomerOrderCart(cart), true);
  assert.deepEqual(customerOrderCustomer(order), { id:'', name:'Guest 42', email:'guest@example.test' });
  assert.equal(validCustomerOrderCart([{ productId:'', desc:'Bad', qty:1, price:1 }]), false);
});

test('staff checkout projection wins over display lines and preserves guest identity', () => {
  const order = { guestName:'Counter guest', guestEmail:'counter@example.test', items:[
    { productId:'coffee', description:'Display line', quantity:1, unitPrice:99 },
  ], checkoutCart:{ items:[
    { productId:'coffee', variantId:'iced', desc:'Accepted coffee', variant:'Iced', qty:2, price:8.5, unit:'cup' },
  ], customer:{ name:'Counter guest', email:'counter@example.test' } } };
  assert.deepEqual(customerOrderCart(order), [
    { productId:'coffee', variantId:'iced', desc:'Accepted coffee', variant:'Iced', unit:'cup', qty:2, price:8.5 },
  ]);
  assert.deepEqual(customerOrderCustomer(order), { id:'', name:'Counter guest', email:'counter@example.test' });
});
