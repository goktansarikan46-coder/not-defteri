// Kalemi çizginin sonunda bekletince elle çizilen şekli düzgün şekle çevirir (GoodNotes'taki gibi):
// düz çizgi, üçgen, dikdörtgen/dörtgen, daire/elips. Tanınmayan açık eğriler olduğu gibi kalır.
// Girdi ve çıktı: [x, y, basınç, ...] dizisi (sayfa koordinatları, pt).

export function recognizeShape(pts) {
  const P = [];
  let pSum = 0;
  for (let i = 0; i < pts.length; i += 3) {
    P.push([pts[i], pts[i + 1]]);
    pSum += pts[i + 2];
  }
  const n = P.length;
  if (n < 5) return null;
  const pressure = Math.round((pSum / n) * 100) / 100;
  let len = 0;
  for (let i = 1; i < n; i++) len += dist(P[i - 1], P[i]);
  const bb = bbox(P);
  const diag = Math.hypot(bb.w, bb.h);
  if (diag < 8) return null;
  const gap = dist(P[0], P[n - 1]);

  // Neredeyse dümdüz → düz çizgi
  if (gap / len > 0.9) return sample([P[0], P[n - 1]], false, pressure);

  // Uçları birbirine yakın değilse kapalı şekil değil: dokunma
  if (gap > 0.3 * diag) return null;

  let V = rdp([...P, P[0]], 0.08 * diag);
  V.pop(); // kapanış noktası
  V = dropFlatCorners(V, 150);

  if (V.length === 3) return sample(V, true, pressure);
  if (V.length === 4) {
    if (isRectangular(V)) {
      // Kenarlar yataya/dikeye yakınsa düzgün dikdörtgen; değilse eğik dikdörtgen olduğu gibi kalır.
      const tilt = Math.abs(angleOf(V[0], V[1]) % 90);
      if (tilt < 12 || tilt > 78) {
        const r = bbox(V);
        return sample([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], true, pressure);
      }
    }
    return sample(V, true, pressure);
  }
  // Köşe yoksa (ya da çok köşe) → elips; en-boy birbirine yakınsa tam daire
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  let rx = bb.w / 2;
  let ry = bb.h / 2;
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) rx = ry = (rx + ry) / 2;
  const out = [];
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(round(cx + rx * Math.cos(a)), round(cy + ry * Math.sin(a)), pressure);
  }
  return out;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (v) => Math.round(v * 100) / 100;
const angleOf = (a, b) => ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;

function bbox(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Ramer–Douglas–Peucker: çizgiyi köşe noktalarına indirger.
function rdp(P, eps) {
  if (P.length < 3) return P.slice();
  const [a, b] = [P[0], P[P.length - 1]];
  let maxD = -1;
  let idx = 0;
  for (let i = 1; i < P.length - 1; i++) {
    const d = segDist(P[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(P.slice(0, idx + 1), eps);
  const right = rdp(P.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (!l2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// İç açısı neredeyse düz (≥ limit derece) olan köşeleri at: çizim başlangıcı kenarın ortasındaysa oluşan sahte köşe gibi.
function dropFlatCorners(V, limit) {
  let changed = true;
  while (changed && V.length > 3) {
    changed = false;
    for (let i = 0; i < V.length; i++) {
      if (interiorAngle(V[(i - 1 + V.length) % V.length], V[i], V[(i + 1) % V.length]) >= limit) {
        V = V.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return V;
}

function interiorAngle(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function isRectangular(V) {
  for (let i = 0; i < 4; i++) {
    const ang = interiorAngle(V[(i + 3) % 4], V[i], V[(i + 1) % 4]);
    if (Math.abs(ang - 90) > 18) return false;
  }
  return true;
}

// Köşeler arasını sık noktalarla doldurur (silgi ve seçim düzgün çalışsın).
function sample(V, closed, pressure) {
  const out = [];
  const list = closed ? [...V, V[0]] : V;
  for (let i = 0; i < list.length - 1; i++) {
    const [a, b] = [list[i], list[i + 1]];
    const steps = Math.max(1, Math.ceil(dist(a, b) / 3));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push(round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t), pressure);
    }
  }
  const last = list[list.length - 1];
  out.push(round(last[0]), round(last[1]), pressure);
  return out;
}
