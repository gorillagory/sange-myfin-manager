const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

export function advancedAnalyticsQuery(from, to) {
  if (!dayPattern.test(String(from || '')) || !dayPattern.test(String(to || '')))
    throw new Error('Choose valid analytics dates.');
  return new URLSearchParams({ from:String(from),to:String(to) });
}

export function formatSen(value, currency = 'RM') {
  let amount;
  try { amount = BigInt(String(value ?? '0')); } catch { amount = 0n; }
  const negative = amount < 0n, absolute = negative ? -amount : amount;
  const whole = absolute / 100n, fraction = String(absolute % 100n).padStart(2,'0');
  return `${negative?'-':''}${String(currency || 'RM')} ${whole.toLocaleString('en-MY')}.${fraction}`;
}

export function formatMilliQuantity(value) {
  let amount;
  try { amount = BigInt(String(value ?? '0')); } catch { amount = 0n; }
  const negative = amount < 0n, absolute = negative ? -amount : amount;
  const whole = absolute / 1000n, fraction = String(absolute % 1000n).padStart(3,'0').replace(/0+$/,'');
  return `${negative?'-':''}${whole.toLocaleString('en-MY')}${fraction?`.${fraction}`:''}`;
}

export function basisPointPercent(value) {
  const points = Math.max(0,Math.min(10000,Number(value)||0));
  return `${(points/100).toLocaleString('en-MY',{minimumFractionDigits:0,maximumFractionDigits:2})}%`;
}

export function costCoveragePresentation(costs = {}) {
  const complete = costs.complete === true;
  return {
    complete,
    percentage:basisPointPercent(costs.coverageBasisPoints),
    title:complete?'Complete item-cost coverage':'Partial item-cost coverage',
    missingLines:Number(costs.missingCostLineCount || 0),
    operatingContributionAvailable:complete && costs.operatingContributionSen !== null
      && costs.operatingContributionSen !== undefined,
  };
}

export function cohortPresentation(metric = {}) {
  return metric.suppressed
    ? { available:false,label:`Hidden until at least ${Number(metric.cohortThreshold || 5)} people qualify` }
    : { available:true,label:`${Number(metric.cohortSize || metric.participatingCustomers || 0)} people` };
}
