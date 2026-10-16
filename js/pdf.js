import * as pdfjsLib from '../vendor/pdf.min.mjs';

const vendor = new URL('../vendor/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = vendor + 'pdf.worker.min.mjs';

export async function openPdf(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjsLib.getDocument({
    data,
    cMapUrl: vendor + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: vendor + 'standard_fonts/',
    isEvalSupported: false,
  }).promise;
}

// Sayfa boyutları PDF noktası (pt) cinsinden, sayfa döndürmesi uygulanmış haliyle.
export async function pageSizes(doc) {
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
    page.cleanup();
  }
  return sizes;
}

export const pdfUtil = pdfjsLib.Util;

export function isPasswordError(err) {
  return err?.name === 'PasswordException';
}
