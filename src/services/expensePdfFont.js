import fontDataUrl from '../assets/fonts/DroidSansFallbackFull.ttf?inline';

const prefix = 'base64,';

export function expensePdfFontOptions() {
  const marker = fontDataUrl.indexOf(prefix);
  if (marker < 0) throw new Error('The expense report font could not be loaded.');
  return {
    fontBase64:fontDataUrl.slice(marker + prefix.length),
    fontFamily:'DroidSansFallbackFull',
    fontFilename:'DroidSansFallbackFull.ttf',
  };
}
