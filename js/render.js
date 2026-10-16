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

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

export async function renderPdfPage(pdfDoc, page, canvas) {
  const pp = await pdfDoc.getPage(page.pdfPage);
  const viewport = pp.getViewport({ scale: canvas.width / page.w });
  await pp.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

export async function renderThumb(pdfDoc, page, strokes, width = 240) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((width * page.h) / page.w);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  if (page.kind === 'pdf' && pdfDoc) await renderPdfPage(pdfDoc, page, c);
  if (strokes?.length) {
    const k = width / page.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawStrokes(ctx, strokes);
  }
  return c.toDataURL('image/jpeg', 0.8);
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
