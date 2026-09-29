export const DEFAULT_THEME_COLOR = '#164e42';

export const THEME_PRESETS = Object.freeze([
  { name: 'Evergreen', value: '#164e42' },
  { name: 'Ocean', value: '#174a7e' },
  { name: 'Indigo', value: '#4338ca' },
  { name: 'Plum', value: '#6b315f' },
  { name: 'Terracotta', value: '#9a3f2c' },
]);

const PAPER = '#ffffff';
const INK = '#172c26';

const channel = value => Math.max(0, Math.min(255, Math.round(value)));

function rgb(hex) {
  const value = normalizeThemeColor(hex);
  return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
}

function hex([red, green, blue]) {
  return `#${[red, green, blue].map(value => channel(value).toString(16).padStart(2, '0')).join('')}`;
}

function mix(first, second, amount) {
  const left = rgb(first), right = rgb(second);
  return hex(left.map((value, index) => value + (right[index] - value) * amount));
}

function luminance(color) {
  const values = rgb(color).map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

export function normalizeThemeColor(value, fallback = DEFAULT_THEME_COLOR) {
  const color = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return `#${[...color.slice(1)].map(character => character.repeat(2)).join('')}`;
  const safeFallback = String(fallback || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(safeFallback) ? safeFallback : DEFAULT_THEME_COLOR;
}

export function contrastRatio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function readableAccent(seed) {
  if (contrastRatio(seed, PAPER) >= 4.5) return seed;
  for (let amount = 0.02; amount <= 1; amount += 0.02) {
    const candidate = mix(seed, '#000000', amount);
    if (contrastRatio(candidate, PAPER) >= 4.5) return candidate;
  }
  return '#000000';
}

export function themeVariables(primaryColor) {
  const seed = normalizeThemeColor(primaryColor);
  const accent = readableAccent(seed);
  const accentText = contrastRatio(accent, PAPER) >= contrastRatio(accent, INK) ? PAPER : INK;
  return {
    '--ed-accent': accent,
    '--ed-accent-hover': mix(accent, '#000000', 0.14),
    '--ed-accent-text': accentText,
    '--ed-focus': accent,
    '--ed-tint': mix(seed, PAPER, 0.93),
  };
}

export function applyThemeVariables(target, primaryColor) {
  const variables = themeVariables(primaryColor);
  if (target?.style?.setProperty) {
    for (const [property, value] of Object.entries(variables)) target.style.setProperty(property, value);
  }
  return variables;
}
