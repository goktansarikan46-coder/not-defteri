// Android uygulaması (APK) içinde çalışırken telefonun kendi özelliklerine köprü.
// Tarayıcıda (GitHub Pages) çalışırken isNative = false olur ve bu dosya hiçbir şey yapmaz.
const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const call = (method, options = {}) => cap.nativePromise('NotDefteri', method, options);

const CHUNK = 3 * 1024 * 1024;

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Dosyayı İndirilenler klasörüne kaydeder (mode 'save') ya da paylaşım ekranını açar (mode 'share').
// Büyük dosyalar köprüden parça parça geçer.
export async function nativeSaveFile(blob, name, mime, mode) {
  const { path } = await call('fileStart', { name });
  for (let i = 0; i < blob.size; i += CHUNK) {
    await call('fileAppend', { path, data: await toBase64(blob.slice(i, i + CHUNK)) });
  }
  await call('fileFinish', { path, mime, mode });
}

// Başka uygulamadan ("Şununla aç" / "Paylaş") gelen PDF'leri sırayla handler'a verir.
export function onIncomingPdf(handler) {
  if (!isNative) return;
  let busy = false;
  const take = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const { files } = await call('take');
        if (!files?.length) break;
        for (const f of files) {
          const res = await fetch(cap.convertFileSrc(f.path));
          const blob = new Blob([await res.blob()], { type: 'application/pdf' });
          await handler(blob, f.name);
          call('done', { path: f.path }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Gelen PDF alınamadı', err);
    } finally {
      busy = false;
    }
  };
  window.addEventListener('ndIncoming', take);
  take();
}
