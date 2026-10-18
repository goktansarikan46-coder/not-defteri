// Kalem izleri sayfa koordinatlarında (PDF noktası) saklanır: { tool, color, width, pts: [x, y, basınç, ...] }.
// Böylece yakınlaştırma ya da çözünürlük ne olursa olsun aynı yere çizilirler.

// Metin kutuları ve resimler de aynı listede, aynı biçimde tutulur; böylece kement, geri alma, kopyalama,
// yedekleme onlarda da çalışır. pts = [solÜstX, solÜstY, 0.5, sağAltX, sağAltY, 0.5].
//   metin: { tool: 'text', text, color, width: yazı boyu (pt), pts }
//   resim: { tool: 'image', src: dataURL, width: 0, pts }
export const isBox = (s) => s.tool === 'text' || s.tool === 'image';

const widthAt = (s, pressure) => s.width * (0.45 + 0.9 * pressure);

export const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const TEXT_LINE = 1.3;

// Metni kutu genişliğine göre satırlara böler (ekranda, küçük resimde ve PDF'te aynı sonuç).
export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (ctx.measureText(next).width <= maxW || !line.trim()) {
        line = next;
        // Tek kelime kutudan genişse harf harf böl.
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

let measureCtx = null;
export function textHeight(text, size, maxW) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${TEXT_FONT}`;
  return Math.max(1, wrapText(measureCtx, text, maxW).length) * size * TEXT_LINE;
}

function drawText(ctx, s) {
  const [x, y, , x2] = s.pts;
  ctx.save();
  ctx.font = `${s.width}px ${TEXT_FONT}`;
  ctx.fillStyle = s.color;
  ctx.textBaseline = 'top';
  wrapText(ctx, s.text, x2 - x).forEach((line, i) => ctx.fillText(line, x, y + i * s.width * TEXT_LINE + s.width * 0.12));
  ctx.restore();
}

// Resimler bir kez çözülüp önbellekte tutulur; yüklenince sayfa yeniden çizilsin diye haber verilir.
const images = new Map();
let onImageReady = null;
export const setImageReadyHandler = (fn) => (onImageReady = fn);

function imageFor(src) {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onImageReady?.();
    img.src = src;
    images.set(src, img);
  }
  return img;
}

// Dışa aktarma / küçük resimden önce resimlerin yüklenmesini bekle; bozuk bir resim her şeyi kilitlemesin diye en fazla 4 sn.
export async function preloadImages(strokes) {
  const waits = strokes
    .filter((s) => s.tool === 'image')
    .map((s) => {
      const img = imageFor(s.src);
      if (img.complete && img.naturalWidth) return null;
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    })
    .filter(Boolean);
  if (waits.length) await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 4000))]);
}

function drawImageItem(ctx, s) {
  const img = imageFor(s.src);
  if (!img.complete || !img.naturalWidth) return;
  const [x, y, , x2, y2] = s.pts;
  ctx.drawImage(img, x, y, x2 - x, y2 - y);
}

export function drawStroke(ctx, s) {
  if (s.tool === 'text') return drawText(ctx, s);
  if (s.tool === 'image') return drawImageItem(ctx, s);
  const p = s.pts;
  const n = p.length / 3;
  if (!n) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;

  if (s.tool === 'hl') {
    // Fosforlu kalem: tek parça yarı saydam yol, üst üste binen yerler koyulaşmasın.
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    for (let i = 1; i < n - 1; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      ctx.quadraticCurveTo(x, y, (x + p[i * 3 + 3]) / 2, (y + p[i * 3 + 4]) / 2);
    }
    if (n > 1) ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
  } else if (n === 1) {
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(p[0], p[1], widthAt(s, p[2]) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Kalem: her parça kendi basıncına göre kalınlaşır, orta noktalardan geçen eğrilerle yumuşatılır.
    // Kalınlığı (gözle fark edilmeyecek kadar) aynı olan ardışık parçalar tek seferde çizilir: sayfayı
    // yeniden çizmek (silgi, geri alma, kaydırma) böylece çok daha hızlı.
    const q = Math.max(0.02, s.width * 0.03);
    let mx = p[0], my = p[1];
    let cur = -1;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    for (let i = 1; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      const last = i === n - 1;
      const ex = last ? x : (x + p[i * 3 + 3]) / 2;
      const ey = last ? y : (y + p[i * 3 + 4]) / 2;
      const lw = Math.round(widthAt(s, (p[i * 3 + 2] + p[i * 3 - 1]) / 2) / q) * q;
      if (lw !== cur) {
        if (cur >= 0) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(mx, my);
        }
        ctx.lineWidth = cur = lw;
      }
      ctx.quadraticCurveTo(x, y, ex, ey);
      mx = ex;
      my = ey;
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawStrokes(ctx, strokes) {
  for (const s of strokes) drawStroke(ctx, s);
}

// Silgi için: nokta bir çizgiye r mesafeden yakın mı?
// Çizgilerin sınır kutusu bir kez hesaplanıp saklanır; silgi uzaktaki çizgileri tek karşılaştırmayla eler.
// (WeakMap: çizginin kendisine alan eklenmez, kayıtlara / yedeğe girmez.)
const boundsCache = new WeakMap();
function boundsOf(s) {
  let b = boundsCache.get(s);
  if (!b) {
    const p = s.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    b = { x0, y0, x1, y1 };
    boundsCache.set(s, b);
  }
  return b;
}

export function hitStroke(s, x, y, r) {
  if (isBox(s)) return false; // silgi metin ve resimlere dokunmaz (onlar kementle silinir)
  const p = s.pts;
  const rr = r + s.width / 2;
  const b = boundsOf(s);
  if (x < b.x0 - rr || x > b.x1 + rr || y < b.y0 - rr || y > b.y1 + rr) return false;
  const rr2 = rr * rr;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr2;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= rr2) return true;
  }
  return false;
}

// Kısmi silgi: çizginin silginin altında kalan kısmını çıkarır, kalan parçaları yeni çizgiler olarak döndürür.
// Çizgiye dokunmuyorsa null döner. Çizgi nesneleri hiç değiştirilmez (geri alma bunlara dayanıyor).
export function eraseFromStroke(s, x, y, r) {
  if (!hitStroke(s, x, y, r)) return null;
  const rr = r + s.width / 2;
  const rr2 = rr * rr;
  const step = Math.max(0.4, r / 3);
  const p = s.pts;
  const pieces = [];
  let run = [];
  const flush = () => {
    if (run.length >= 6) pieces.push({ ...s, pts: run });
    run = [];
  };
  const visit = (px, py, pr) => {
    if ((px - x) ** 2 + (py - y) ** 2 <= rr2) flush();
    else run.push(Math.round(px * 100) / 100, Math.round(py * 100) / 100, pr);
  };
  visit(p[0], p[1], p[2]);
  for (let i = 3; i < p.length; i += 3) {
    // Seyrek noktalar arasını doldur ki silgi iki nokta arasından "kaçmasın".
    const [ax, ay, ap, bx, by, bp] = [p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      visit(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
    }
  }
  flush();
  return pieces;
}

export function strokesBounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const pad = isBox(s) ? 0 : s.width / 2;
    for (let i = 0; i < s.pts.length; i += 3) {
      x0 = Math.min(x0, s.pts[i] - pad);
      y0 = Math.min(y0, s.pts[i + 1] - pad);
      x1 = Math.max(x1, s.pts[i] + pad);
      y1 = Math.max(y1, s.pts[i + 1] + pad);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Çizgiyi kaydırır / ölçekler: (x, y) → (ox + (x - ax) * k + dx, ...). Yeni nesne döndürür.
export function transformStroke(s, { dx = 0, dy = 0, k = 1, ax = 0, ay = 0 }) {
  const p = s.pts;
  const pts = new Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    pts[i] = Math.round((ax + (p[i] - ax) * k + dx) * 100) / 100;
    pts[i + 1] = Math.round((ay + (p[i + 1] - ay) * k + dy) * 100) / 100;
    pts[i + 2] = p[i + 2];
  }
  return { ...s, pts, width: Math.round(s.width * k * 100) / 100 };
}

// Kement: çizginin noktalarının en az yarısı çokgenin içindeyse seçilir.
export function strokeInPolygon(s, poly) {
  const p = s.pts;
  if (isBox(s)) return pointInPolygon((p[0] + p[3]) / 2, (p[1] + p[4]) / 2, poly); // kutunun ortası içerideyse
  let inside = 0;
  for (let i = 0; i < p.length; i += 3) if (pointInPolygon(p[i], p[i + 1], poly)) inside++;
  return inside / (p.length / 3) >= 0.5;
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/* ---------------- Sayfa şablonları ---------------- */

export const TEMPLATES = [
  { id: 'blank', label: 'Boş' },
  { id: 'lined', label: 'Çizgili' },
  { id: 'grid', label: 'Kareli' },
  { id: 'dotted', label: 'Noktalı' },
];
const MM5 = 14.17; // 5 mm, PDF noktası cinsinden

// Şablonu çizgi ve noktalar olarak tarif eder; aynı tarif hem ekrana hem dışa aktarılan PDF'e çizilir.
// lines: [x1, y1, x2, y2, renk, kalınlık]   dots: [x, y, yarıçap, renk]
export function templateShapes(page) {
  const { w, h } = page;
  const lines = [];
  const dots = [];
  switch (page.template) {
    case 'lined':
      for (let y = 72; y <= h - 30; y += 24) lines.push([0, y, w, y, '#c3cfe0', 0.6]);
      lines.push([58, 0, 58, h, '#f0a3a3', 0.8]);
      break;
    case 'grid':
      for (let x = MM5; x < w; x += MM5) lines.push([x, 0, x, h, '#d3dcea', 0.45]);
      for (let y = MM5; y < h; y += MM5) lines.push([0, y, w, y, '#d3dcea', 0.45]);
      break;
    case 'dotted':
      for (let y = MM5; y < h; y += MM5) for (let x = MM5; x < w; x += MM5) dots.push([x, y, 0.8, '#a9b5c7']);
      break;
  }
  return { lines, dots };
}

// ctx sayfa koordinatlarına (pt) ölçeklenmiş olmalı.
export function drawTemplate(ctx, page) {
  const { lines, dots } = templateShapes(page);
  ctx.save();
  for (const [x1, y1, x2, y2, color, width] of lines) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  if (dots.length) {
    ctx.fillStyle = dots[0][3];
    ctx.beginPath();
    for (const [x, y, r] of dots) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

export const hasTemplate = (page) => page.kind !== 'pdf' && !!page.template && page.template !== 'blank';

export async function renderPdfPage(pdfDoc, page, canvas) {
  const pp = await pdfDoc.getPage(page.pdfPage);
  const viewport = pp.getViewport({ scale: canvas.width / page.w });
  await pp.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

// Kart tablette ~200px genişliğinde, ekran yoğunluğu 2x; 560px netlik için yeterli.
// THUMB_VERSION artınca eski düşük çözünürlüklü küçük resimler kitaplıkta yeniden üretilir.
export const THUMB_VERSION = 2;
const THUMB_WIDTH = 560;

export async function renderThumb(pdfDoc, page, strokes, width = THUMB_WIDTH) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((width * page.h) / page.w);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  if (page.kind === 'pdf' && pdfDoc) await renderPdfPage(pdfDoc, page, c);
  if (strokes?.length) await preloadImages(strokes);
  const k = width / page.w;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (hasTemplate(page)) drawTemplate(ctx, page);
  if (strokes?.length) drawStrokes(ctx, strokes);
  return c.toDataURL('image/jpeg', 0.86);
}

// Dışa aktarma için şeffaf arka planlı yüksek çözünürlüklü mürekkep katmanı.
export function renderInkLayer(page, strokes, scale) {
  const maxArea = 10_000_000; // büyük sayfalarda belleği taşırmasın
  const k = Math.min(scale, Math.sqrt(maxArea / (page.w * page.h)));
  const c = document.createElement('canvas');
  c.width = Math.round(page.w * k);
  c.height = Math.round(page.h * k);
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawStrokes(ctx, strokes);
  return c;
}

export function canvasBytes(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('Görüntü oluşturulamadı'))), type, quality);
  });
}
