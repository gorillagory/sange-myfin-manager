const LANES = Object.freeze(['pending','preparing','ready']);

const text = value => String(value || '').trim();
const lower = value => text(value).toLocaleLowerCase();

function productIndex(products = []) {
  return new Map(products.map(product => [text(product.id), product]));
}

function itemStation(item, products) {
  const product = products.get(text(item.productId || item.product_id)) || {};
  return text(product.subcategory) || text(product.category) || 'General';
}

function itemOutput(item, products) {
  return {
    productId: text(item.productId || item.product_id),
    variantId: text(item.variantId || item.variant_id),
    description: text(item.description || item.desc || item.name) || 'Item',
    variant: text(item.variant || item.variantName),
    sku: text(item.sku),
    unit: text(item.unit) || 'item',
    quantity: Number(item.quantity ?? item.qty ?? 0),
    station: itemStation(item, products),
  };
}

export function kitchenTicket(order, kind, products = []) {
  if (!order || !['request','paid'].includes(kind)) return null;
  const sourceStatus = text(order.status);
  const lane = kind === 'request' && sourceStatus === 'accepted' ? 'pending' : sourceStatus;
  if (!LANES.includes(lane) || (kind === 'request' && !['accepted','preparing','ready'].includes(sourceStatus))) return null;
  const indexedProducts = products instanceof Map ? products : productIndex(products);
  const items = (order.items || order.checkoutCart?.items || []).map(item => itemOutput(item, indexedProducts));
  const stations = [...new Set(items.map(item => item.station))].sort((a,b) => a.localeCompare(b));
  const code = text(order.code || order.orderCode || order.number) || text(order.id).slice(0,8).toUpperCase();
  const source = order.serviceMode === 'delivery'
    ? `Delivery${order.delivery?.zoneName ? ` · ${order.delivery.zoneName}` : ''}`
    : text(order.locationName || order.location?.name || order.location?.tableLabel)
      || (order.serviceMode === 'table' ? 'At premise' : kind === 'request' ? 'Pickup' : 'Counter');
  return {
    id: text(order.id), key: `${kind}:${text(order.id)}`, kind, code, lane,
    sourceStatus, version: Number(order.version), items, stations, source,
    customerName: text(order.customerName || order.guestName || order.checkoutCart?.customer?.name) || 'Walk-in customer',
    notes: text(order.notes || order.note || order.customerNote),
    createdAt: order.createdAt || order.saleDate || null,
    dueAt: order.pickupAt || null,
    paymentLabel: kind === 'request' ? 'Pay at counter' : 'Paid',
    nextStatus: lane === 'pending' ? 'preparing' : lane === 'preparing' ? 'ready' : kind === 'paid' ? 'completed' : '',
    raw: order,
  };
}

export function kitchenTickets({ requests = [], paid = [], products = [], station = '', query = '' } = {}) {
  const indexedProducts = productIndex(products);
  const rows = [
    ...requests.map(order => kitchenTicket(order, 'request', indexedProducts)),
    ...paid.map(order => kitchenTicket(order, 'paid', indexedProducts)),
  ].filter(Boolean);
  const stationKey = lower(station), queryKey = lower(query);
  return rows.filter(ticket => (!stationKey || ticket.stations.some(value => lower(value) === stationKey)) &&
    (!queryKey || lower([
      ticket.code,ticket.id,ticket.customerName,ticket.source,ticket.notes,
      ...ticket.items.flatMap(item => [item.description,item.variant,item.sku,item.station]),
    ].join(' ')).includes(queryKey)))
    .sort((a,b) => {
      const lane = LANES.indexOf(a.lane) - LANES.indexOf(b.lane);
      if (lane) return lane;
      const aTime = Date.parse(a.dueAt || a.createdAt || 0) || 0;
      const bTime = Date.parse(b.dueAt || b.createdAt || 0) || 0;
      return aTime - bTime || a.code.localeCompare(b.code);
    });
}

export function kitchenStations({ requests = [], paid = [], products = [] } = {}) {
  return [...new Set(kitchenTickets({ requests,paid,products }).flatMap(ticket => ticket.stations))]
    .sort((a,b) => a.localeCompare(b));
}

export const kitchenLabelCode = ticket => `MYFIN|KITCHEN|${ticket.kind}|${ticket.id}`;

export function findKitchenTicket(tickets, scanned) {
  const value = text(scanned), normalized = lower(value);
  if (!normalized) return null;
  const parts = value.split('|');
  const payload = parts.length === 4 && parts[0].toUpperCase() === 'MYFIN' && parts[1].toUpperCase() === 'KITCHEN'
    ? { kind:lower(parts[2]), id:lower(parts[3]) } : null;
  return tickets.find(ticket => payload
    ? ticket.kind === payload.kind && lower(ticket.id) === payload.id
    : [ticket.id,ticket.code,ticket.raw?.number].some(candidate => lower(candidate) === normalized)) || null;
}

export function kitchenStickerLines(ticket, maximum = 100) {
  const labels = [];
  for (const item of ticket?.items || []) {
    const quantity = Number(item.quantity);
    const copies = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    for (let copy = 1; copy <= copies && labels.length < maximum; copy++)
      labels.push({ ...item, copy, copies });
    if (labels.length === maximum) break;
  }
  return labels;
}

export const KITCHEN_LANES = LANES;
