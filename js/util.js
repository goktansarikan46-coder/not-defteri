// Her yayında bir artır (sw.js içindeki CACHE adıyla aynı sayı); kitaplığın köşesinde görünür.
export const APP_VERSION = 7;

// crypto.randomUUID yalnızca HTTPS'te var; yerel ağdan (http) açıldığında da çalışsın diye kendi kimlik üreticimiz.
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* depolama kapalıysa ayarlar sadece bu oturumda kalır */
  }
}

export const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const round2 = (n) => Math.round(n * 100) / 100;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
