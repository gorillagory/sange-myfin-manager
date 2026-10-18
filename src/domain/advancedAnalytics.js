const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value) {
  const text=String(value || ''),stamp=Date.parse(text);
  return dayPattern.test(text) && Number.isFinite(stamp)
    && new Date(stamp).toISOString().slice(0,10)===text;
}

export function recentAnalyticsRange(to, days = 30) {
  const end=String(to || ''),count=Number(days);
  if (!validDay(end) || !Number.isInteger(count) || count<1 || count>366)
    throw new Error('Choose a valid recent analytics range.');
  const start=new Date(Date.parse(end));
  start.setUTCDate(start.getUTCDate()-(count-1));
  return { from:start.toISOString().slice(0,10),to:end };
}

export function analyticsErrorMessage(error) {
  const message=typeof error==='string' ? error : error?.message;
  if (message==='analytics_range_too_dense')
    return 'This range contains too many sales to analyze at once. Choose a shorter date range.';
  if (message==='analytics_product_range_too_dense')
    return 'This range contains too many products to analyze at once. Choose a shorter date range.';
  if (message==='analytics_pricing_snapshot_mismatch')
    return 'Stored pricing evidence is incomplete for this range. Ask an administrator to review the affected sales.';
  if (message==='invalid_analytics_range')
    return 'Choose valid analytics dates spanning no more than 366 days.';
  return message || 'Business analytics could not be loaded.';
}

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

export function changePresentation(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return { comparable:false,label:'No prior-period baseline',tone:'neutral' };
  const points=Number(value),percentage=Math.abs(points/100).toLocaleString('en-MY',{
    minimumFractionDigits:0,maximumFractionDigits:1,
  });
  if (points===0) return { comparable:true,label:'No change vs prior period',tone:'neutral' };
  return { comparable:true,label:`${points>0?'Up':'Down'} ${percentage}% vs prior period`,
    tone:points>0?'positive':'negative' };
}

export function ratioPercent(part, whole) {
  const numerator=Math.max(0,Number(part)||0),denominator=Math.max(0,Number(whole)||0);
  if (!denominator) return '0%';
  return `${Math.min(100,numerator*100/denominator).toLocaleString('en-MY',{
    minimumFractionDigits:0,maximumFractionDigits:1,
  })}%`;
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
