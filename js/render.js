// Kalem izleri sayfa koordinatlarında (PDF noktası) saklanır: { tool, color, width, pts: [x, y, basınç, ...] }.
// Böylece yakınlaştırma ya da çözünürlük ne olursa olsun aynı yere çizilirler.

const widthAt = (s, pressure) => s.width * (0.45 + 0.9 * pressure);

export function drawStroke(ctx, s) {
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
    let mx = p[0], my = p[1];
    for (let i = 1; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      const last = i === n - 1;
      const ex = last ? x : (x + p[i * 3 + 3]) / 2;
      const ey = last ? y : (y + p[i * 3 + 4]) / 2;
      ctx.lineWidth = widthAt(s, (p[i * 3 + 2] + p[i * 3 - 1]) / 2);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.quadraticCurveTo(x, y, ex, ey);
      ctx.stroke();
      mx = ex;
      my = ey;
    }
  }
  ctx.restore();
}

export function drawStrokes(ctx, strokes) {
  for (const s of strokes) drawStroke(ctx, s);
}

// Silgi için: nokta bir çizgiye r mesafeden yakın mı?
export function hitStroke(s, x, y, r) {
  const p = s.pts;
  const rr = r + s.width / 2;
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
    const pad = s.width / 2;
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
  const k = width / page.w;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (hasTemplate(page)) drawTemplate(ctx, page);
  if (strokes?.length) drawStrokes(ctx, strokes);
  return c.toDataURL('image/jpeg', 0.86);
}

// Dışa aktarma için şeffaf arka planlı yüksek çözünürlüklü mürekkep katmanı.
export function renderInkLayer(page, strokes, scale) {
  const maxArea = 20_000_000;
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
