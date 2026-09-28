// Online use remains possible when optional browser settings storage is blocked.
// Paid receipts always use IndexedDB transactions, never this fallback.
const fallback = new Map();
export const localSettings = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return fallback.get(key) ?? null;
    }
  },
  setItem(key, value) {
    fallback.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Optional settings only. */
    }
  },
  removeItem(key) {
    fallback.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional settings only. */
    }
  },
};
