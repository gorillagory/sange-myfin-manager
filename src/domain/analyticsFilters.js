const keys = ['channel', 'paymentMethod', 'category', 'subcategory'];
const clean = value => String(value || '').trim();
const same = (left, right) => clean(left).toLocaleLowerCase('en-US') === clean(right).toLocaleLowerCase('en-US');

export function analyticsReportQuery(from, to, filters = {}) {
  const query = new URLSearchParams({ from, to });
  for (const key of keys) {
    const value = clean(filters[key]);
    if (value) query.set(key, value);
  }
  return query;
}

export function analyticsSubcategoryOptions(filterOptions = {}, category = '') {
  const options = Array.isArray(filterOptions.subcategories) ? filterOptions.subcategories : [];
  return clean(category) ? options.filter(option => same(option.category, category)) : options;
}

export function analyticsFilterLabels(filters = {}, filterOptions = {}) {
  const labels = [];
  const optionLabel = (group, value) => (filterOptions[group] || [])
    .find(option => same(option.value, value))?.label || clean(value);
  if (clean(filters.channel)) labels.push(`Channel: ${optionLabel('channels', filters.channel)}`);
  if (clean(filters.paymentMethod)) labels.push(`Payment: ${optionLabel('paymentMethods', filters.paymentMethod)}`);
  if (clean(filters.category)) labels.push(`Category: ${optionLabel('categories', filters.category)}`);
  if (clean(filters.subcategory)) labels.push(`Subcategory: ${optionLabel('subcategories', filters.subcategory)}`);
  return labels;
}
