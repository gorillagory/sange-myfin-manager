import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  eligibilityActions, normalizeMaskedReferenceHint, parseCategoryTargets,
  promotionPayload, senFromRinggit, studentReviewPayload, voucherPayload,
} from '../src/domain/studentPrograms.js';
import { permissionsFor } from '../src/domain/permissions.js';
import { canVisit, ROUTE_CAPABILITIES } from '../src/domain/viewAccess.js';

test('student administration capabilities distinguish review from owner configuration', () => {
  for (const role of ['super', 'super_admin', 'workspace_owner']) {
    const permission = permissionsFor({ role });
    assert.equal(permission.studentProgramsRead, true);
    assert.equal(permission.studentEligibilityReview, true);
    assert.equal(permission.promotionsManage, true);
    assert.equal(canVisit({ role }, '/student-programs'), true);
  }
  for (const role of ['manager', 'company_admin']) {
    const permission = permissionsFor({ role });
    assert.equal(permission.studentProgramsRead, true);
    assert.equal(permission.studentEligibilityReview, false);
    assert.equal(permission.promotionsManage, true);
    assert.equal(canVisit({ role }, '/student-programs'), true);
  }
  for (const role of ['operator', 'company_user']) {
    assert.equal(permissionsFor({ role }).studentProgramsRead, false);
    assert.equal(canVisit({ role }, '/student-programs'), false);
  }
  assert.equal(ROUTE_CAPABILITIES['/student-programs'], 'studentProgramsRead');
});

test('student review controls are hidden from read-only managers', async () => {
  const source = await readFile(new URL('../src/components/dashboard/marketing/MarketingEligibility.vue', import.meta.url), 'utf8');
  assert.match(source, /v-if="canReview" class="ed-actions"/);
  assert.match(source, /v-if="!canReview" class="ed-notice"/);
  assert.match(source, /<Modal v-if="review&&canReview"/);
});

test('student review payload permits only masked reference hints and decision fields', () => {
  assert.equal(normalizeMaskedReferenceHint(' ***A9 '), '***A9');
  assert.throws(() => normalizeMaskedReferenceHint('STUDENT-9912'), /Reference hint/);
  assert.deepEqual(studentReviewPayload({
    expectedVersion:2, status:'verified', institutionName:' University of Malaya ',
    referenceHint:'***9912', validUntil:'2027-10-01T00:00:00+08:00',
  }), {
    expectedVersion:2, status:'verified', institutionName:'University of Malaya',
    referenceHint:'***9912', validUntil:'2027-09-30T16:00:00.000Z', reason:'',
  });
  assert.throws(() => studentReviewPayload({
    status:'rejected', institutionName:'UM', reason:'no',
  }), /Review reason/);
  assert.throws(() => studentReviewPayload({
    status:'pending', institutionName:'UM', rawDocument:'data:image/png;base64,no',
  }), /must not be entered or uploaded/);
  assert.throws(() => studentReviewPayload({
    status:'pending', institutionName:'UM', studentNumber:'9912',
  }), /must not be entered or uploaded/);
  assert.deepEqual(eligibilityActions({ status:'unreviewed' }), ['pending']);
  assert.deepEqual(eligibilityActions({ status:'pending' }), ['verified', 'rejected']);
  assert.deepEqual(eligibilityActions({ status:'verified' }), ['verified', 'revoked']);
});

test('promotion payload is integer-sen, scoped, deduplicated and optimistic', () => {
  const payload = promotionPayload({
    expectedVersion:3, name:' Student lunch ', enabled:true, redemptionMode:'automatic',
    validFrom:'2026-10-09T10:00:00+08:00', validUntil:'2026-12-01T00:00:00+08:00',
    discountType:'percentage', discountBasisPoints:1500, minSubtotalSen:1000,
    maxDiscountSen:500, requiresStudent:true, stackable:false, priority:10,
    productTargets:'coffee/large, coffee/large, pastry',
    categoryTargets:' Beverages / Coffee, beverages/coffee, Pastry ',
    customerTargets:'cust-1,cust-1,cust-2',
  });
  assert.equal(payload.expectedVersion, 3);
  assert.equal(payload.requiresCustomer, true);
  assert.equal(payload.discountBasisPoints, 1500);
  assert.equal(payload.discountSen, null);
  assert.deepEqual(payload.productTargets, [
    { productId:'coffee', variantId:'large' }, { productId:'pastry', variantId:'' },
  ]);
  assert.deepEqual(payload.categoryTargets, [
    { category:'beverages', subcategory:'coffee' }, { category:'pastry', subcategory:'' },
  ]);
  assert.deepEqual(payload.customerTargets, ['cust-1', 'cust-2']);
  assert.throws(() => promotionPayload({
    name:'Bad', redemptionMode:'automatic', validFrom:'2026-10-10', validUntil:'2026-10-09',
    discountType:'fixed', discountSen:50,
  }), /expiry/);
});

test('voucher create sends plaintext once while edits cannot rotate a code', () => {
  const created = voucherPayload({
    code:' student-10 ', enabled:true, validFrom:'2026-10-09T00:00:00Z',
    maxRedemptions:100, perCustomerLimit:1,
  }, { creating:true });
  assert.equal(created.code, 'STUDENT-10');
  assert.equal(voucherPayload({code:'STAFF',campaignId:'campaign-1',enabled:true,validFrom:'2026-10-09T00:00:00Z'},{creating:true}).campaignId,'campaign-1');
  const edited = voucherPayload({
    code:'SHOULD-NOT-LEAVE-THE-FORM', expectedVersion:4, enabled:false,
    validFrom:'2026-10-09T00:00:00Z',
  });
  assert.equal('code' in edited, false);
  assert.equal(edited.expectedVersion, 4);
  assert.equal(voucherPayload({ code:'staff', enabled:true, validFrom:'2026-10-09T00:00:00Z' }, { creating:true }).code,'STAFF');
  assert.equal(voucherPayload({ code:'STAFF', expectedVersion:Number.NaN, validFrom:'2026-10-09' }, { creating:true }).expectedVersion, 0);
  assert.equal(voucherPayload({ code:'STAFF', expectedVersion:42, validFrom:'2026-10-09' }, { creating:true }).expectedVersion, 0);
  assert.throws(() => voucherPayload({ expectedVersion:Number.NaN, validFrom:'2026-10-09' }), /Voucher version/);
  for (const code of ['bad code','-STAFF','STAFF-'])
    assert.throws(() => voucherPayload({ code, validFrom:'2026-10-09' }, { creating:true }), /start and end/);
});

test('money entry converts to integer sen without floating point rounding', () => {
  assert.equal(senFromRinggit('19.90'), 1990);
  assert.equal(senFromRinggit('0.05'), 5);
  assert.throws(() => senFromRinggit('19.999'), /two decimal/);
});

test('student programs UI explains live storefront pricing and never captures identity documents', async () => {
  const [legacy,eligibility,offers] = await Promise.all([
    readFile(new URL('../src/components/dashboard/StudentProgramsTab.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/dashboard/marketing/MarketingEligibility.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/dashboard/marketing/MarketingOffers.vue', import.meta.url), 'utf8'),
  ]);
  const component=`${eligibility}\n${offers}`;
  assert.match(legacy, /Student Programs moved/);
  assert.match(legacy, /\/marketing\?tab=eligibility/);
  assert.match(component, /Customer eligibility/);
  assert.match(component, /OFFERS &amp; REUSABLE CODES/);
  assert.match(component, /never enter or upload/i);
  assert.match(component, /type="text" minlength="3"/);
  assert.match(component, /Copy code/);
  assert.match(component, /Download QR/);
  assert.match(offers, /const existing=row\?\.id&&row\?\.promotionId\?row:null/);
  assert.match(offers, /localError\.value=!existing&&!voucherOffers\.value\.some/);
  assert.match(offers, /creating&&!offer\)throw new Error\('Choose a campaign offer\.'\)/);
  assert.equal(offers.match(/Choose a campaign offer\./g)?.length, 2);
  assert.doesNotMatch(component, /type="file"|accept="image|FormData/);
});
