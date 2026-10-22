export function terminalDeviceProfile() {
  const release = typeof document === 'undefined' ? '' : document.querySelector('meta[name="myfin-release"]')?.content || '';
  return {
    label:typeof navigator === 'undefined' ? '' : `${navigator.platform || 'Browser'} · ${navigator.userAgentData?.mobile ? 'Mobile' : 'Web'}`,
    platform:typeof navigator === 'undefined' ? '' : navigator.userAgentData?.platform || navigator.platform || '',
    appVersion:release,
  };
}
