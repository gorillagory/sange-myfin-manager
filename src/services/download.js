export function downloadFile(content, filename, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const safeFilename = value => String(value || 'download').replace(/[^a-z0-9_-]/gi,'_').slice(0,80);
