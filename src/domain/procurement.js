const Q_SCALE = 1_000_000n;

const text = value => String(value ?? '').normalize('NFKC').trim();

export const IDENTIFIER_TYPES = Object.freeze([
  'gtin', 'ean', 'upc', 'manufacturer_barcode', 'supplier_barcode', 'internal_sku', 'qr',
]);

export function normalizeStockIdentifier(type, value) {
  if (!IDENTIFIER_TYPES.includes(type)) throw new Error('Unsupported identifier type.');
  const raw = text(value);
  if (!raw || raw.length > 256) throw new Error('Identifier must contain 1 to 256 characters.');
  const normalized = ['gtin', 'ean', 'upc'].includes(type)
    ? raw.replace(/[\s-]/g, '')
    : raw.toLocaleUpperCase('en-US');
  if (['gtin', 'ean', 'upc'].includes(type)) {
    if (!/^\d+$/.test(normalized)) throw new Error('GTIN, EAN and UPC identifiers must contain digits only.');
    const allowed = type === 'upc' ? [12] : type === 'ean' ? [8, 13] : [8, 12, 13, 14];
    if (!allowed.includes(normalized.length)) throw new Error(`Invalid ${type.toUpperCase()} length.`);
    const digits = [...normalized].map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let index = digits.length - 1, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3)
      sum += digits[index] * weight;
    if ((10 - (sum % 10)) % 10 !== check) throw new Error(`Invalid ${type.toUpperCase()} check digit.`);
  }
  return { raw, normalized };
}

export function quantityMicros(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000)
    throw new Error('Quantity must be greater than zero and no more than 1,000,000.');
  const micros = BigInt(Math.round(number * Number(Q_SCALE)));
  if (Math.abs(number * Number(Q_SCALE) - Number(micros)) > 1e-5)
    throw new Error('Quantity supports at most six decimal places.');
  return micros;
}

const positiveSen = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)
    throw new Error('Price must be a non-negative integer number of sen.');
  return BigInt(value);
};

// Purchase quantities can be fractional, but every posted amount is rounded to
// one whole sen using half-up arithmetic. This keeps JavaScript floating point
// out of the accounting boundary.
export function lineTotalSen(quantity, unitPriceSen) {
  const numerator = quantityMicros(quantity) * positiveSen(unitPriceSen);
  return (numerator + Q_SCALE / 2n) / Q_SCALE;
}

export function baseQuantity(receivedPurchaseQuantity, quantityInBase) {
  const numerator = quantityMicros(receivedPurchaseQuantity) * quantityMicros(quantityInBase);
  const rounded = (numerator + Q_SCALE / 2n) / Q_SCALE;
  if (rounded <= 0n) throw new Error('Base quantity must be greater than zero.');
  return Number(rounded) / Number(Q_SCALE);
}

export function weightedAverageCost(current = {}, receipt = {}) {
  const quantityBefore = Number(current.quantity ?? 0);
  const valueBeforeSen = BigInt(current.valueSen ?? 0);
  const quantityAdded = Number(receipt.quantity ?? 0);
  const valueAddedSen = BigInt(receipt.valueSen ?? 0);
  if (![quantityBefore, quantityAdded].every(Number.isFinite) || quantityBefore < 0 || quantityAdded <= 0)
    throw new Error('Weighted-average quantities are invalid.');
  if (valueBeforeSen < 0n || valueAddedSen < 0n) throw new Error('Weighted-average values are invalid.');
  const quantity = Math.round((quantityBefore + quantityAdded) * 1e6) / 1e6;
  const valueSen = valueBeforeSen + valueAddedSen;
  return { quantity, valueSen, averageCostSen: quantity ? Number(valueSen) / quantity : 0 };
}

export function reverseWeightedAverageCost(current = {}, reversal = {}) {
  const quantityBefore = Number(current.quantity ?? 0);
  const valueBeforeSen = BigInt(current.valueSen ?? 0);
  const quantityRemoved = Number(reversal.quantity ?? 0);
  const valueRemovedSen = BigInt(reversal.valueSen ?? 0);
  if (![quantityBefore, quantityRemoved].every(Number.isFinite) || quantityRemoved <= 0 || quantityRemoved > quantityBefore + 1e-9)
    throw new Error('Reversal exceeds the cost basis.');
  if (valueRemovedSen < 0n || valueRemovedSen > valueBeforeSen) throw new Error('Reversal exceeds the cost value.');
  const quantity = Math.max(0, Math.round((quantityBefore - quantityRemoved) * 1e6) / 1e6);
  const valueSen = valueBeforeSen - valueRemovedSen;
  if (!quantity && valueSen) throw new Error('A zero quantity cannot retain cost value.');
  return { quantity, valueSen, averageCostSen: quantity ? Number(valueSen) / quantity : 0 };
}

export function purchaseOrderStatus(orderedLines = [], receivedByLine = new Map()) {
  if (!orderedLines.length) throw new Error('A purchase order needs at least one line.');
  let receivedAny = false;
  let complete = true;
  for (const line of orderedLines) {
    const ordered = Number(line.orderedPurchaseQuantity ?? line.ordered_purchase_quantity);
    const received = Number(receivedByLine.get(line.id) ?? 0);
    if (!Number.isFinite(ordered) || ordered <= 0 || !Number.isFinite(received) || received < 0 || received > ordered + 1e-9)
      throw new Error('Purchase order receipt quantity is invalid.');
    receivedAny ||= received > 0;
    complete &&= received + 1e-9 >= ordered;
  }
  return complete ? 'received' : receivedAny ? 'partially_received' : 'submitted';
}

export function prepareReceiptLines(orderLines = [], receivedByLine = new Map(), requested = []) {
  if (!requested.length) throw new Error('Add at least one receipt line.');
  const lines = new Map(orderLines.map(line => [line.id, line]));
  const seen = new Set();
  return requested.map(input => {
    if (seen.has(input.purchaseOrderLineId)) throw new Error('Each purchase order line may be received once per receipt.');
    seen.add(input.purchaseOrderLineId);
    const line = lines.get(input.purchaseOrderLineId);
    if (!line) throw new Error('Purchase order line was not found.');
    const quantity = Number(input.quantity);
    const ordered = Number(line.orderedPurchaseQuantity ?? line.ordered_purchase_quantity);
    const received = Number(receivedByLine.get(line.id) ?? 0);
    quantityMicros(quantity);
    if (received + quantity > ordered + 1e-9) throw new Error('Receipt exceeds the outstanding purchase quantity.');
    const factor = Number(line.quantityInBase ?? line.quantity_in_base);
    const unitPriceSen = Number(line.unitPriceSen ?? line.unit_price_sen);
    return {
      ...input,
      stockItemId: line.stockItemId ?? line.stock_item_id,
      purchaseUnit: line.purchaseUnit ?? line.purchase_unit,
      quantity,
      baseQuantity: baseQuantity(quantity, factor),
      costSen: lineTotalSen(quantity, unitPriceSen),
    };
  });
}

