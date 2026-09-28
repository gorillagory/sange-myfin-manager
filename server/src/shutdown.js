export function installShutdown(app, {
  signals = process, timeoutMs = 10000, exit = code => process.exit(code),
  setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  let pending;
  const stop = () => {
    if (pending) return pending;
    const timer = setTimer(() => exit(1), timeoutMs);
    timer.unref?.();
    pending = Promise.resolve().then(() => app.close()).then(
      () => { clearTimer(timer); remove(); },
      () => { clearTimer(timer); remove(); exit(1); }
    );
    return pending;
  };
  function remove() {
    signals.removeListener('SIGTERM', stop);
    signals.removeListener('SIGINT', stop);
  }
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
  return { stop, remove };
}
