import * as db from './db.js';
import * as ui from './ui.js';
import { icon } from './icons.js';
import { openPdf } from './pdf.js';
import {
  drawStroke,
  drawStrokes,
  hitStroke,
  renderPdfPage,
  renderThumb,
  renderInkLayer,
  canvasBytes,
  THUMB_VERSION,
  drawTemplate,
  templateShapes,
  hasTemplate,
  eraseFromStroke,
  strokesBounds,
  transformStroke,
  strokeInPolygon,
  isBox,
  textHeight,
  TEXT_FONT,
  TEXT_LINE,
  setImageReadyHandler,
  preloadImages,
} from './render.js';
import { recognizeShape } from './shapes.js';
import { pdfUtil } from './pdf.js';
import { uid, loadJSON, saveJSON, round2, clamp, fold } from './util.js';

const DEFAULT_PEN_COLORS = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7c3aed'];
const DEFAULT_HL_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa', '#fb923c'];
// Renk seçicide çıkan hazır renkler
const PEN_PRESETS = [
  '#111827', '#4b5563', '#9ca3af', '#ffffff', '#1e3a8a', '#1d4ed8', '#0ea5e9', '#06b6d4',
  '#0d9488', '#15803d', '#22c55e', '#84cc16', '#ca8a04', '#f59e0b', '#ea580c', '#dc2626',
  '#b91c1c', '#f43f5e', '#ec4899', '#c026d3', '#9333ea', '#7c3aed', '#92400e', '#78350f',
];
const HL_PRESETS = [
  '#facc15', '#fde047', '#a3e635', '#4ade80', '#2dd4bf', '#38bdf8', '#60a5fa', '#c084fc',
  '#f472b6', '#fb7185', '#fb923c', '#d1d5db',
];
// Kalınlıklar PDF noktası (pt) cinsinden. Hazır seçenekler + kaydırıcıyla ince ayar.
const SIZES = {
  pen: { presets: [0.5, 0.8, 1.2, 1.6, 2.2, 3, 4.5, 6], min: 0.3, max: 8, step: 0.1, label: 'Kalem kalınlığı' },
  hl: { presets: [5, 8, 12, 16, 22, 30], min: 3, max: 40, step: 1, label: 'Fosforlu kalem kalınlığı' },
};
const OLD_PEN_WIDTHS = [0.9, 1.6, 2.8];
const OLD_HL_WIDTHS = [8, 14, 22];
const ERASER_SIZES = [6, 12, 22]; // silgi yarıçapı, ekran pikseli
const SHAPE_HOLD_MS = 550; // kalemi bu kadar bekletince çizgi düzgün şekle dönüşür
const MAX_FAVORITES = 8;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
// Sayfa başına tuval boyutu üst sınırı (piksel). Cihazın belleğine göre ayarlanır: büyük PDF'lerde
// birkaç sayfa aynı anda bellekte durduğu için yüksek sınır uygulamanın kapanmasına yol açıyordu.
const DEVICE_MEMORY = navigator.deviceMemory || 4;
const MAX_CANVAS_AREA = DEVICE_MEMORY >= 8 ? 8_000_000 : DEVICE_MEMORY >= 4 ? 6_000_000 : 4_000_000;
let pdfQueue = Promise.resolve(); // PDF sayfaları tek tek çizilir
const PALM_GUARD_MS = 450; // kalem yakındayken parmak/avuç dokunuşları yok sayılır
const A4 = { w: 595.28, h: 841.89 };

const settings = loadJSON('nd-tools', { tool: 'pen', penColor: 0, hlColor: 0, penWidth: 1, hlWidth: 1, fingerDraw: false });
// Eski sürümde kalınlık 3 seçenekten birinin sırasıydı; o seçimi gerçek kalınlığa çevir.
settings.penSize ??= OLD_PEN_WIDTHS[settings.penWidth] ?? 1.6;
settings.hlSize ??= OLD_HL_WIDTHS[settings.hlWidth] ?? 14;
settings.eraserMode ??= 'stroke'; // 'stroke': dokunulan çizginin tamamı, 'partial': yalnızca üzerinden geçilen kısım
settings.eraserSize ??= 1;
settings.favorites ??= [];
settings.textColor ??= 0;
settings.textSize ??= 1;
// Araç çubuğundaki 5'er renk kutusu değiştirilebilir (renk seçiciden); dizi yerinde güncellenir.
settings.penPalette ??= DEFAULT_PEN_COLORS.slice();
settings.hlPalette ??= DEFAULT_HL_COLORS.slice();
const PEN_COLORS = settings.penPalette;
const HL_COLORS = settings.hlPalette;
// Favoriler eskiden renk sırasını tutuyordu; renk kutuları artık değişebildiği için rengin kendisini tut.
settings.favorites = settings.favorites.map((f) => (f.hex ? f : { ...f, hex: (f.tool === 'hl' ? DEFAULT_HL_COLORS : DEFAULT_PEN_COLORS)[f.color] }));
// Ayarlar ekranından açılıp kapatılabilen özellikler (varsayılan: açık)
settings.gestureUndo ??= true; // iki parmakla dokun = geri al
settings.gestureRedo ??= true; // üç parmakla dokun = yinele
settings.shapeSnap ??= true; // kalemi bekletince şekle dönüştür
settings.pressure ??= true; // kalem basıncına göre kalınlık
settings.penButtonEraser ??= true; // kalemin düğmesi basılıyken silgi
settings.backupReminder ??= true; // kitaplıkta yedek hatırlatıcısı (library.js okur)
settings.pageDrag ??= false; // tüm sayfalar ekranında tutamaktan sürükleyerek sıra değiştirme (varsayılan: kapalı)
const TEXT_SIZES = [
  { size: 12, label: 'Küçük' },
  { size: 16, label: 'Normal' },
  { size: 22, label: 'Büyük' },
  { size: 30, label: 'Başlık' },
];
const eraserRadius = () => ERASER_SIZES[settings.eraserSize] ?? ERASER_SIZES[1];
const saveSettings = () => saveJSON('nd-tools', settings);

const $ = (id) => document.getElementById(id);
let pagesEl, sheetEl, indicatorEl, liveCanvas;
let onBack = () => {};
let ed = null; // açık defterin durumu

export const isEditorOpen = () => ed !== null;

export function initEditor(opts) {
  onBack = opts.onBack;
  pagesEl = $('pages');
  indicatorEl = $('page-indicator');
  sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';
  pagesEl.append(sheetEl);
  liveCanvas = document.createElement('canvas');
  liveCanvas.className = 'live';
  // Resimler yüklenince görünen sayfaları yeniden çiz (kısa aralıklarla gelen yüklemeleri birleştir).
  let imgTimer = 0;
  setImageReadyHandler(() => {
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => ed?.views.forEach((v) => v.visible && v.drawInk(selectionHidden(v))), 30);
  });
  buildToolbar();
  bindInput();
  window.addEventListener('resize', () => {
    if (!ed) return;
    layout();
    scheduleRerender();
  });
  // Uygulamadan çıkılırken (ana ekrana dönme, başka uygulamaya geçme, ekranı kapatma) her şeyi hemen kaydet.
  // Açık bir metin kutusu da kutuya dönüştürülüp kaydedilir: Android uygulamayı arka planda kapatırsa yazı kaybolmasın.
  const saveNow = () => {
    if (!ed) return;
    commitText();
    flushSaves();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('pagehide', saveNow);
}

/* ---------------- Açma / kapama ---------------- */

export async function openEditor(id) {
  const hide = ui.busy('Açılıyor…');
  try {
    const nb = await db.get('notebooks', id);
    if (!nb) throw new Error('Defter bulunamadı');
    let pdf = null;
    if (nb.fileId) {
      const file = await db.get('files', nb.fileId);
      if (file) pdf = await openPdf(file.blob);
    }
    const ink = new Map((await db.getAllByIndex('ink', 'notebookId', id)).map((r) => [r.pageId, r.strokes]));
    for (const p of nb.pages) if (!ink.has(p.id)) ink.set(p.id, []);
    ed = { nb, pdf, ink, views: [], zoom: 1, pxPerPt: 1, undo: [], redo: [], dirty: new Set(), changed: false, saveTimer: 0, renderTimer: 0, io: null };
    $('tb-title').textContent = nb.title;
    buildPages();
    pagesEl.scrollLeft = 0;
    const last = ed.views[clamp(nb.lastPage || 0, 0, ed.views.length - 1)];
    pagesEl.scrollTop = last ? last.el.offsetTop - 12 : 0;
    updateToolbar();
    updateIndicator();
  } finally {
    hide();
  }
}

export async function closeEditor() {
  if (!ed) return;
  const e = ed;
  if (sizePop) closeSizePop();
  if (favPop) closeFavPop();
  closeColorPop();
  commitText();
  clearSelection();
  while (closeOverlays());
  pageTextCache.clear();
  active = null;
  touches.clear();
  stopInertia();
  await flushSaves();
  e.nb.lastPage = currentIndex();
  if (e.changed) {
    e.nb.updatedAt = Date.now();
    try {
      e.nb.thumb = await renderThumb(e.pdf, e.nb.pages[0], e.ink.get(e.nb.pages[0].id));
      e.nb.thumbV = THUMB_VERSION;
    } catch (err) {
      console.warn('Küçük resim oluşturulamadı', err);
    }
  }
  await db.put('notebooks', e.nb);
  e.io.disconnect();
  for (const v of e.views) v.release();
  sheetEl.innerHTML = '';
  e.pdf?.destroy();
  ed = null;
}

/* ---------------- Sayfalar ---------------- */

class PageView {
  constructor(page) {
    this.page = page;
    this.visible = false;
    this.resKey = null;
    this.seq = 0;
    this.task = null;
    this.sharp = null;
    this.sharpSeq = 0;
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el._view = this;
    if (page.kind === 'pdf' || hasTemplate(page)) {
      this.bg = document.createElement('canvas');
      this.bg.className = 'bg';
      this.el.append(this.bg);
    }
    this.ink = document.createElement('canvas');
    this.ink.className = 'ink';
    this.el.append(this.ink);
    updateBookmark(this);
  }

  get strokes() {
    return ed.ink.get(this.page.id);
  }

  targetSize() {
    const dpr = window.devicePixelRatio || 1;
    let w = this.page.w * ed.pxPerPt * dpr;
    let h = this.page.h * ed.pxPerPt * dpr;
    if (w * h > MAX_CANVAS_AREA) {
      const s = Math.sqrt(MAX_CANVAS_AREA / (w * h));
      w *= s;
      h *= s;
    }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  async render() {
    if (!this.visible || !ed) return;
    const { w, h } = this.targetSize();
    const key = w + 'x' + h;
    if (key === this.resKey) return;
    this.resKey = key;
    this.inkSize = { w, h };
    const seq = ++this.seq;
    // Not katmanı yalnızca sayfada not varsa bellekte tutulur (boş sayfalar için tam boy tuval açılmaz).
    this.ink.width = this.ink.height = 0;
    this.drawInk(selectionHidden(this));
    if (this.page.kind !== 'pdf') {
      // Şablon (çizgi/kare/nokta) vektörel olduğu için her çözünürlükte anında çizilir.
      if (this.bg) {
        this.bg.width = w;
        this.bg.height = h;
        const ctx = this.bg.getContext('2d');
        const k = w / this.page.w;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        drawTemplate(ctx, this.page);
      }
      return;
    }
    if (!ed.pdf) return;
    // PDF sayfaları sırayla, tek tek çizilir: aynı anda birçok büyük sayfa çizmek belleği taşırıp
    // uygulamanın kapanmasına yol açıyordu. Sıra gelene kadar sayfa ekrandan çıktıysa atlanır.
    const job = async () => {
      if (seq !== this.seq || !ed?.pdf) return;
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      try {
        this.pp ??= await ed.pdf.getPage(this.page.pdfPage);
        if (seq !== this.seq) return;
        this.task = this.pp.render({ canvasContext: tmp.getContext('2d'), viewport: this.pp.getViewport({ scale: w / this.page.w }) });
        await this.task.promise;
        if (seq !== this.seq) return;
        // Kopyalamak yerine yeni tuvali yerine koy: aynı anda iki tam boy kopya bellekte durmasın.
        tmp.className = 'bg';
        const old = this.bg;
        old.replaceWith(tmp);
        old.width = old.height = 0;
        this.bg = tmp;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.error(err);
      } finally {
        this.task = null;
        if (tmp !== this.bg) tmp.width = tmp.height = 0;
      }
    };
    pdfQueue = pdfQueue.then(job, job);
  }

  release() {
    this.seq++;
    this.task?.cancel();
    this.task = null;
    this.resKey = null;
    this.dropSharp();
    if (this.bg) this.bg.width = this.bg.height = 0;
    this.ink.width = this.ink.height = 0;
    // pdf.js'in bu sayfa için tuttuğu yazı tipi / resim verilerini de bırak.
    try {
      this.pp?.cleanup();
    } catch {
      /* sayfa o an çiziliyorsa temizlik sonra yapılır */
    }
    this.pp = null;
  }

  // Not katmanını gerektiğinde aç (sayfa görünür ve üzerinde not varken).
  ensureInk() {
    if (!this.ink.width && this.visible && this.inkSize) {
      this.ink.width = this.inkSize.w;
      this.ink.height = this.inkSize.h;
    }
    return this.ink.width > 0;
  }

  inkContext() {
    const ctx = this.ink.getContext('2d');
    const k = this.ink.width / this.page.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return ctx;
  }

  // exclude: o an taşınan (canlı katmanda çizilen) çizgiler
  drawInk(exclude) {
    if (!this.strokes?.length) {
      // Not kalmadıysa katmanı bellekten tamamen bırak.
      if (this.ink.width) this.ink.width = this.ink.height = 0;
      this.drawSharpInk(null);
      return;
    }
    if (!this.ensureInk()) return;
    const ctx = this.ink.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    const list = exclude ? this.strokes.filter((s) => !exclude.has(s)) : this.strokes;
    drawStrokes(this.inkContext(), list);
    this.drawSharpInk(list);
  }

  addStroke(s) {
    if (!this.ink.width) return this.drawInk();
    drawStroke(this.inkContext(), s);
    if (this.sharp?.ink.width) drawStroke(sharpContext(this.sharp.ink, this.sharp), s);
    else this.drawSharpInk(this.strokes);
  }

  /* --- Keskin katman ---
     Bellek sınırı yüzünden büyük ya da yakınlaştırılmış sayfalar ekrandan düşük çözünürlükte çizilir;
     büyütülünce yazılar pikselli görünür. Böyle bir sayfada yalnızca ekranda görünen kısım, ekranın tam
     çözünürlüğünde ayrı tuvallere (arka plan + yazılar) bir kez daha çizilir. Düşük çözünürlüklü tam sayfa
     altta kalır: kaydırırken yeni açılan yerler hemen görünür, kaydırma durunca keskinleşir. */

  needsSharp() {
    if (!this.visible || !this.inkSize) return false;
    return this.inkSize.w / this.page.w < ed.pxPerPt * (window.devicePixelRatio || 1) * 0.97;
  }

  renderSharp() {
    const view = this.needsSharp() && visibleRegion(this, 0);
    if (!view) return this.dropSharp();
    const S = ed.pxPerPt * (window.devicePixelRatio || 1);
    const sh = this.sharp;
    // Keskin alan ekranda görüneni hâlâ kapsıyorsa yeniden çizmeye gerek yok.
    if (sh && sh.S === S && view.x * S >= sh.ox && view.y * S >= sh.oy &&
        (view.x + view.w) * S <= sh.ox + sh.cw && (view.y + view.h) * S <= sh.oy + sh.ch) return;
    const region = regionAt(visibleRegion(this, 0.2), S);
    const seq = ++this.sharpSeq;
    this.sharpTask?.cancel();
    region.ink = sh?.ink || sharpCanvas('ink sharp');
    region.bg = sh?.bg || null;
    placeSharp(region.ink, region, this.page);
    if (!region.ink.isConnected) this.ink.after(region.ink);
    this.sharp = region;
    this.drawInk(selectionHidden(this));
    // Alttaki yazı katmanında keskin alanın yeri boş bırakılır: aynı yazı iki kez çizilip koyulaşmasın.
    const px = (v) => ((v / S / this.page.w) * 100).toFixed(3) + '%';
    const py = (v) => ((v / S / this.page.h) * 100).toFixed(3) + '%';
    const [x0, y0, x1, y1] = [px(region.ox), py(region.oy), px(region.ox + region.cw), py(region.oy + region.ch)];
    this.ink.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0})`;
    if (!this.bg) return; // boş sayfa: arka plan yok
    const c = sharpCanvas('bg sharp');
    c.width = region.cw;
    c.height = region.ch;
    const swapIn = () => {
      if (seq !== this.sharpSeq) return (c.width = c.height = 0);
      placeSharp(c, region, this.page);
      if (region.bg) {
        region.bg.replaceWith(c);
        region.bg.width = region.bg.height = 0;
      } else this.ink.before(c);
      region.bg = c;
    };
    if (this.page.kind !== 'pdf') {
      // Şablonun altı opak olmalı ki alttaki çizgilerle üst üste binip koyulaşmasın.
      const ctx = sharpContext(c, region);
      ctx.fillStyle = '#fff';
      ctx.fillRect(region.ox / S, region.oy / S, region.cw / S, region.ch / S);
      drawTemplate(ctx, this.page);
      return swapIn();
    }
    if (!ed.pdf) return;
    const job = async () => {
      if (seq !== this.sharpSeq || !ed?.pdf) return (c.width = c.height = 0);
      try {
        this.pp ??= await ed.pdf.getPage(this.page.pdfPage);
        if (seq !== this.sharpSeq) return (c.width = c.height = 0);
        this.sharpTask = this.pp.render({
          canvasContext: c.getContext('2d'),
          viewport: this.pp.getViewport({ scale: S }),
          transform: [1, 0, 0, 1, -region.ox, -region.oy],
        });
        await this.sharpTask.promise;
        swapIn();
      } catch (err) {
        c.width = c.height = 0;
        if (err?.name !== 'RenderingCancelledException') console.error(err);
      } finally {
        this.sharpTask = null;
      }
    };
    pdfQueue = pdfQueue.then(job, job);
  }

  drawSharpInk(list) {
    const sh = this.sharp;
    if (!sh) return;
    if (!list?.length) {
      if (sh.ink.width) sh.ink.width = sh.ink.height = 0; // yazı yoksa bellekte yer tutmasın
      return;
    }
    if (sh.ink.width !== sh.cw || sh.ink.height !== sh.ch) {
      sh.ink.width = sh.cw;
      sh.ink.height = sh.ch;
    } else {
      const ctx = sh.ink.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, sh.cw, sh.ch);
    }
    drawStrokes(sharpContext(sh.ink, sh), list);
  }

  dropSharp() {
    this.sharpSeq++;
    this.sharpTask?.cancel();
    this.sharpTask = null;
    if (!this.sharp) return;
    for (const c of [this.sharp.ink, this.sharp.bg]) {
      if (!c) continue;
      c.remove();
      c.width = c.height = 0;
    }
    this.sharp = null;
    this.ink.style.clipPath = '';
  }
}

// Sayfanın ekranda görünen kısmı (sayfa noktası cinsinden); pad: kaydırmaya karşı ekranın bu oranı kadar pay.
function visibleRegion(v, pad) {
  const pr = v.el.getBoundingClientRect();
  const vr = pagesEl.getBoundingClientRect();
  const mx = vr.width * pad, my = vr.height * pad;
  const x0 = Math.max(pr.left, vr.left - mx), x1 = Math.min(pr.right, vr.right + mx);
  const y0 = Math.max(pr.top, vr.top - my), y1 = Math.min(pr.bottom, vr.bottom + my);
  if (x1 <= x0 || y1 <= y0) return null;
  const k = v.page.w / pr.width;
  return { x: (x0 - pr.left) * k, y: (y0 - pr.top) * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
}

// Bölgeyi ekran piksellerine oturt (S: sayfa noktası başına ekran pikseli).
function regionAt(r, S) {
  const ox = Math.floor(r.x * S), oy = Math.floor(r.y * S);
  return { S, ox, oy, cw: Math.ceil((r.x + r.w) * S) - ox, ch: Math.ceil((r.y + r.h) * S) - oy };
}

function sharpCanvas(className) {
  const c = document.createElement('canvas');
  c.className = className;
  return c;
}

// Keskin tuval sayfanın içine yüzde ile yerleşir: yakınlaştırırken sayfayla birlikte büyür.
function placeSharp(c, r, page) {
  const pct = (v, total) => ((v / r.S / total) * 100).toFixed(3) + '%';
  Object.assign(c.style, { inset: 'auto', left: pct(r.ox, page.w), top: pct(r.oy, page.h), width: pct(r.cw, page.w), height: pct(r.ch, page.h) });
}

function sharpContext(c, r) {
  const ctx = c.getContext('2d');
  ctx.setTransform(r.S, 0, 0, r.S, -r.ox, -r.oy);
  return ctx;
}

let sharpTimer = 0;
function scheduleSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = setTimeout(() => ed?.views.forEach((v) => v.visible && v.renderSharp()), 150);
}


function buildPages() {
  sheetEl.innerHTML = '';
  pullEl = document.createElement('div');
  pullEl.className = 'pull-add';
  sheetEl.append(pullEl);
  ed.io = new IntersectionObserver(onIntersect, { root: pagesEl, rootMargin: '60% 0px' });
  for (const page of ed.nb.pages) {
    const v = new PageView(page);
    ed.views.push(v);
    sheetEl.append(v.el);
  }
  layout();
  for (const v of ed.views) ed.io.observe(v.el);
}

function onIntersect(entries) {
  for (const entry of entries) {
    const v = entry.target._view;
    v.visible = entry.isIntersecting;
    if (v.visible) v.render();
    else v.release();
  }
  scheduleSharp();
}

function layout() {
  if (!ed) return;
  const cw = pagesEl.clientWidth;
  const maxW = Math.max(...ed.nb.pages.map((p) => p.w));
  const fit = Math.max(240, cw - 32);
  ed.pxPerPt = (fit * ed.zoom) / maxW;
  let widest = 0;
  for (const v of ed.views) {
    const w = v.page.w * ed.pxPerPt;
    v.el.style.width = w + 'px';
    v.el.style.height = v.page.h * ed.pxPerPt + 'px';
    widest = Math.max(widest, w);
  }
  sheetEl.style.width = Math.max(cw, widest + 32) + 'px';
  if (textEdit) styleTextEditor(false); // yazı boyu yakınlaştırmayla birlikte ölçeklensin
}

function scheduleRerender() {
  clearTimeout(ed.renderTimer);
  ed.renderTimer = setTimeout(() => {
    if (!ed) return;
    for (const v of ed.views) if (v.visible) v.render();
    scheduleSharp();
  }, 180);
}

function currentIndex() {
  if (!ed?.views.length) return 0;
  const mid = pagesEl.scrollTop + pagesEl.clientHeight / 2;
  let idx = 0;
  for (let i = 0; i < ed.views.length; i++) {
    if (ed.views[i].el.offsetTop <= mid) idx = i;
    else break;
  }
  return idx;
}

let indicatorRaf = 0;
function updateIndicator() {
  indicatorRaf = 0;
  if (!ed) return;
  indicatorEl.textContent = `${currentIndex() + 1} / ${ed.views.length}`;
}

function setZoom(z, cx, cy) {
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(z - ed.zoom) < 1e-4) return;
  // Parmakların / imlecin altındaki nokta yakınlaştırmadan sonra da aynı yerde kalsın.
  const v = document.elementFromPoint(cx, cy)?.closest?.('.page')?._view || ed.views[currentIndex()];
  const r = v.el.getBoundingClientRect();
  const fx = (cx - r.left) / r.width;
  const fy = (cy - r.top) / r.height;
  ed.zoom = z;
  layout();
  const r2 = v.el.getBoundingClientRect();
  pagesEl.scrollLeft += r2.left + fx * r2.width - cx;
  pagesEl.scrollTop += r2.top + fy * r2.height - cy;
  scheduleRerender();
  updateIndicator();
}

function zoomBy(factor) {
  const r = pagesEl.getBoundingClientRect();
  setZoom(ed.zoom * factor, r.left + r.width / 2, r.top + r.height / 2);
}

/* ---------------- Sayfa ekleme / silme ---------------- */

// Ekranın ortasındaki sayfaya göre çalışır; sağ alttaki sayaç hangi sayfa olduğunu gösterir.
async function pageMenu() {
  if (!ed) return;
  const idx = currentIndex();
  const action = await ui.actionSheet({
    title: `Sayfa ${idx + 1} / ${ed.views.length}`,
    actions: [
      ...(clipboard?.length ? [{ id: 'paste', label: 'Yapıştır (kopyalanan yazı)' }] : []),
      { id: 'add', label: 'Sayfa ekle…' },
      { id: 'duplicate', label: 'Bu sayfayı çoğalt' },
      { id: 'bookmark', label: ed.views[idx].page.bookmark ? 'Yer imini kaldır' : 'Yer imi ekle' },
      { id: 'overview', label: 'Tüm sayfalar' },
      ...(Math.abs(ed.zoom - 1) > 0.01 ? [{ id: 'fit', label: 'Sayfayı ekrana sığdır' }] : []),
      { id: 'settings', label: 'Ayarlar' },
      { id: 'delete', label: 'Bu sayfayı sil', danger: true },
    ],
  });
  if (!ed) return;
  if (action === 'settings') openSettings();
  else if (action === 'bookmark') toggleBookmark(idx);
  else if (action === 'fit') zoomBy(1 / ed.zoom);
  else if (action === 'paste') pasteClipboard(idx);
  else if (action === 'add') addPageDialog(idx);
  else if (action === 'duplicate') duplicatePage(idx);
  else if (action === 'overview') openOverview();
  else if (action === 'delete') deletePage(ed.views[idx]);
}

async function addPageDialog(idx) {
  const choice = await ui.templatePicker({ title: 'Sayfa ekle', withPosition: true });
  if (!choice || !ed) return;
  insertBlank(choice.position === 'before' ? idx : idx + 1, choice.template);
}

async function insertBlank(index, template = 'blank') {
  if (!ed) return;
  const ref = ed.nb.pages[index - 1] || ed.nb.pages[index] || A4;
  const page = { id: uid(), kind: 'blank', w: ref.w, h: ref.h, template };
  ed.nb.pages.splice(index, 0, page);
  ed.ink.set(page.id, []);
  const v = new PageView(page);
  if (index < ed.views.length) ed.views[index].el.before(v.el);
  else ed.views[index - 1].el.after(v.el);
  ed.views.splice(index, 0, v);
  layout();
  ed.io.observe(v.el);
  ed.changed = true;
  await saveNotebook();
  pagesEl.scrollTop = v.el.offsetTop - 12;
  updateIndicator();
  ui.toast(`Sayfa eklendi (sayfa ${index + 1})`);
}

async function duplicatePage(idx) {
  if (!ed) return;
  const src = ed.nb.pages[idx];
  const page = { ...src, id: uid() };
  const strokes = structuredClone(ed.ink.get(src.id) || []);
  ed.nb.pages.splice(idx + 1, 0, page);
  ed.ink.set(page.id, strokes);
  const v = new PageView(page);
  ed.views[idx].el.after(v.el);
  ed.views.splice(idx + 1, 0, v);
  layout();
  ed.io.observe(v.el);
  ed.changed = true;
  await saveNotebook();
  if (strokes.length) markDirty(page.id);
  pagesEl.scrollTop = v.el.offsetTop - 12;
  updateIndicator();
  refreshOverview();
  ui.toast(`Sayfa ${idx + 1} çoğaltıldı`);
}

// Sayfaları verilen kimlik sırasına göre dizer (genel bakışta sürükle-bırak).
async function reorderPages(order) {
  const byId = new Map(ed.views.map((v) => [v.page.id, v]));
  ed.views = order.map((id) => byId.get(id));
  ed.nb.pages = ed.views.map((v) => v.page);
  sheetEl.append(...ed.views.map((v) => v.el)); // DOM düğümleri taşınır, çizilmiş tuvaller korunur
  layout();
  ed.changed = true;
  await saveNotebook();
  updateIndicator();
}

function scrollToPage(idx) {
  const v = ed.views[clamp(idx, 0, ed.views.length - 1)];
  pagesEl.scrollTop = v.el.offsetTop - 12;
  updateIndicator();
}

async function deletePage(v) {
  if (ed.views.length <= 1) {
    ui.toast('Defterde en az bir sayfa kalmalı');
    return;
  }
  const idx = ed.views.indexOf(v);
  const hasInk = v.strokes.length > 0;
  const ok = await ui.confirmModal({
    title: `Sayfa ${idx + 1} silinsin mi?`,
    message:
      (v.page.kind === 'pdf' ? 'Bu PDF sayfası defterden kaldırılacak' : 'Bu boş sayfa silinecek') +
      (hasInk ? ' ve üzerindeki notlar da silinecek.' : '.') +
      ' Bu işlem geri alınamaz.',
  });
  if (!ok || !ed) return;
  if (selection?.v === v) clearSelection();
  if (textEdit?.v === v) commitText();
  const id = v.page.id;
  ed.io.unobserve(v.el);
  v.release();
  v.el.remove();
  ed.views.splice(idx, 1);
  ed.nb.pages.splice(idx, 1);
  ed.ink.delete(id);
  ed.dirty.delete(id);
  ed.undo = ed.undo.filter((op) => op.pageId !== id);
  ed.redo = ed.redo.filter((op) => op.pageId !== id);
  ed.changed = true;
  await db.del('ink', id);
  await saveNotebook();
  layout();
  updateToolbar();
  updateIndicator();
  refreshOverview();
  ui.toast('Sayfa silindi');
}

/* ---------------- Sayfa genel bakışı ---------------- */

let overview = null; // { el, grid, io, thumbs: Map }

export function closeOverlays() {
  if (search) {
    search.el.remove();
    search = null;
    return true;
  }
  if (!overview) return false;
  overview.io.disconnect();
  overview.el.remove();
  overview = null;
  return true;
}

function openOverview() {
  if (!ed || overview) return;
  const el = document.createElement('div');
  el.className = 'overview';
  el.innerHTML = `<header class="ov-head"><b>Tüm sayfalar</b><span class="ov-hint">Dokun: sayfaya git${settings.pageDrag ? ' · Tutamaktan sürükle: sırayı değiştir' : ''}</span>
    <button class="chip" id="ov-bm">${icon('bookmark')}<span>Yer imleri</span></button>
    <button class="icon" id="ov-close" title="Kapat">${icon('close')}</button></header><div class="ov-grid"></div>`;
  $('editor').append(el);
  const grid = el.querySelector('.ov-grid');
  overview = { el, grid, io: new IntersectionObserver(onThumbVisible, { root: grid, rootMargin: '300px' }), thumbs: new Map(), onlyBookmarks: false };
  el.querySelector('#ov-bm').onclick = (e) => {
    overview.onlyBookmarks = !overview.onlyBookmarks;
    e.currentTarget.classList.toggle('active', overview.onlyBookmarks);
    refreshOverview();
  };
  // Genel bakış tarayıcı geçmişine bir adım olarak eklenir: geri hareketi onu kapatır, defteri değil.
  history.pushState({ ...history.state, overview: true }, '');
  el.querySelector('#ov-close').onclick = () => history.back();
  refreshOverview();
  grid.querySelector('.ov-tile.current')?.scrollIntoView({ block: 'center' });
}

function refreshOverview() {
  if (!overview || !ed) return;
  const { grid, io } = overview;
  io.disconnect();
  grid.innerHTML = '';
  const cur = currentIndex();
  const filtering = overview.onlyBookmarks;
  if (filtering && !ed.views.some((v) => v.page.bookmark)) {
    grid.innerHTML = '<p class="search-empty">Henüz yer imi yok. Bir sayfada ⋮ menüsünden "Yer imi ekle"yi seç.</p>';
  }
  ed.views.forEach((v, i) => {
    if (filtering && !v.page.bookmark) return;
    const tile = document.createElement('div');
    tile.className = 'ov-tile' + (i === cur ? ' current' : '') + (v.page.bookmark ? ' bookmarked' : '') + (filtering || !settings.pageDrag ? ' no-drag' : '');
    tile.dataset.id = v.page.id;
    tile.innerHTML = `<button class="ov-thumb" style="aspect-ratio:${v.page.w}/${v.page.h}"></button>
      <div class="ov-foot"><button class="ov-grip" title="Sürükleyerek taşı">${icon('grip')}</button>
      <span class="ov-num">${i + 1}</span><button class="ov-more" title="Seçenekler">${icon('more')}</button></div>`;
    tile.querySelector('.ov-thumb').onclick = () => {
      const idx = ed.views.findIndex((x) => x.page.id === v.page.id);
      history.back();
      scrollToPage(idx);
    };
    tile.querySelector('.ov-more').onclick = () => tileMenu(v.page.id);
    tile.querySelector('.ov-grip').addEventListener('pointerdown', (e) => startTileDrag(e, tile));
    grid.append(tile);
    io.observe(tile);
  });
}

async function tileMenu(pageId) {
  const idx = ed.views.findIndex((v) => v.page.id === pageId);
  const action = await ui.actionSheet({
    title: `Sayfa ${idx + 1}`,
    actions: [
      { id: 'duplicate', label: 'Çoğalt' },
      { id: 'add', label: 'Sonrasına sayfa ekle…' },
      { id: 'bookmark', label: ed.views[idx].page.bookmark ? 'Yer imini kaldır' : 'Yer imi ekle' },
      { id: 'delete', label: 'Sil', danger: true },
    ],
  });
  if (!ed) return;
  if (action === 'bookmark') toggleBookmark(idx);
  else if (action === 'duplicate') duplicatePage(idx);
  else if (action === 'delete') deletePage(ed.views[idx]);
  else if (action === 'add') {
    const choice = await ui.templatePicker({ title: 'Sayfa ekle' });
    if (choice && ed) {
      await insertBlank(idx + 1, choice.template);
      refreshOverview();
    }
  }
}

async function onThumbVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting || !overview) continue;
    overview.io.unobserve(entry.target);
    const id = entry.target.dataset.id;
    const page = ed.nb.pages.find((p) => p.id === id);
    if (!page) continue;
    const strokes = ed.ink.get(id) || [];
    const key = id + ':' + strokes.length;
    let url = overview.thumbs.get(key);
    if (!url) {
      try {
        url = await renderThumb(ed.pdf, page, strokes, 300);
      } catch {
        continue;
      }
      overview?.thumbs.set(key, url);
    }
    const btn = entry.target.querySelector('.ov-thumb');
    if (btn) btn.style.backgroundImage = `url(${url})`;
  }
}

// Tutamaktan sürükle-bırak: kart parmağı/kalemi takip eder, bırakılınca yeni sıra kaydedilir.
function startTileDrag(e, tile) {
  e.preventDefault();
  if (overview.onlyBookmarks) return; // filtreli görünümde sıralama yapılmaz (gizli sayfalar karışmasın)
  const grip = e.currentTarget;
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* yoksay */
  }
  const grid = overview.grid;
  const r = tile.getBoundingClientRect();
  const ghost = tile.cloneNode(true);
  ghost.classList.add('ov-ghost');
  ghost.style.width = r.width + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  document.body.append(ghost);
  tile.classList.add('dragging');
  const offX = e.clientX - r.left;
  const offY = e.clientY - r.top;
  let scrollRaf = 0;
  let lastY = e.clientY;
  const move = (ev) => {
    lastY = ev.clientY;
    ghost.style.left = ev.clientX - offX + 'px';
    ghost.style.top = ev.clientY - offY + 'px';
    ghost.style.display = 'none';
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ov-tile');
    ghost.style.display = '';
    if (over && over !== tile) {
      const o = over.getBoundingClientRect();
      over[ev.clientX < o.left + o.width / 2 ? 'before' : 'after'](tile);
    }
    if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
  };
  const autoScroll = () => {
    scrollRaf = 0;
    const g = grid.getBoundingClientRect();
    const edge = 70;
    const dy = lastY < g.top + edge ? -12 : lastY > g.bottom - edge ? 12 : 0;
    if (dy) {
      grid.scrollTop += dy;
      scrollRaf = requestAnimationFrame(autoScroll);
    }
  };
  const end = async () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    cancelAnimationFrame(scrollRaf);
    ghost.remove();
    tile.classList.remove('dragging');
    const order = [...grid.querySelectorAll('.ov-tile')].map((t) => t.dataset.id);
    const changed = order.some((id, i) => id !== ed.nb.pages[i].id);
    if (changed) {
      await reorderPages(order);
      grid.querySelectorAll('.ov-num').forEach((n, i) => (n.textContent = i + 1));
      ui.toast('Sayfa sırası değişti');
    }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

/* ---------------- Kaydetme ---------------- */

function markDirty(pageId) {
  ed.dirty.add(pageId);
  ed.changed = true;
  clearTimeout(ed.saveTimer);
  // Kısa bir duraklamadan sonra kaydet. Kayıt sırasında sayfanın tüm çizgileri kopyalandığı için
  // kalem / silgi o an kullanılıyorsa beklenir: yazarken ya da araç değiştirirken takılma olmasın.
  // (Uygulamadan çıkılırken ve defter kapanırken beklemeden kaydedilir.)
  ed.saveTimer = setTimeout(function trySave() {
    if (!ed) return;
    if (active) ed.saveTimer = setTimeout(trySave, 400);
    else flushSaves();
  }, 800);
}

async function flushSaves() {
  if (!ed) return;
  clearTimeout(ed.saveTimer);
  const { nb, ink } = ed;
  const ids = [...ed.dirty].filter((id) => ink.has(id));
  ed.dirty.clear();
  if (!ids.length) return;
  // Değişen sayfalar ve defterin "son değişiklik" zamanı tek işlemde yazılır (yarım kayıt olmaz);
  // böylece uygulama defter açıkken kapansa bile yedek hatırlatıcısı değişikliği görür.
  nb.updatedAt = Date.now();
  try {
    await db.putMany({
      ink: ids.map((pageId) => ({ pageId, notebookId: nb.id, strokes: ink.get(pageId) })),
      notebooks: [nb],
    });
  } catch (err) {
    console.error(err);
    if (ed?.nb === nb) ids.forEach((id) => ed.dirty.add(id)); // bir sonraki denemede tekrar yazılsın
    ui.toast('Kaydedilemedi! Tablette yer kalmamış olabilir.');
  }
}

async function saveNotebook() {
  ed.nb.updatedAt = Date.now();
  await db.put('notebooks', ed.nb);
}

/* ---------------- Araç çubuğu ---------------- */

function buildToolbar() {
  const tb = $('toolbar');
  tb.innerHTML = `
    <button class="icon" id="tb-back" title="Kitaplığa dön">${icon('back')}</button>
    <button class="doc-title" id="tb-title" title="Adı değiştir"></button>
    <span class="sep"></span>
    <div class="tools-pill">
    <button class="icon tool" data-tool="pen" title="Kalem">${icon('pen')}</button>
    <button class="icon tool" data-tool="hl" title="Fosforlu kalem">${icon('highlighter')}</button>
    <button class="icon tool" data-tool="eraser" title="Silgi">${icon('eraser')}</button>
    <button class="icon tool" data-tool="lasso" title="Kement: çevresini çizerek seç, taşı, büyüt, sil">${icon('lasso')}</button>
    <button class="icon tool" data-tool="text" title="Metin kutusu: sayfaya dokun ve yaz">${icon('text')}</button>
    </div>
    <span class="sep"></span>
    <div class="group" id="tb-colors"></div>
    <div class="group" id="tb-widths"></div>
    <button class="icon" id="tb-fav" title="Favori kalemler">${icon('star')}</button>
    <span class="lasso-hint" id="tb-lasso-hint">Seçmek istediğin yazının çevresini çiz</span>
    <span class="sep"></span>
    <button class="icon" id="tb-undo" title="Geri al (iki parmakla dokun)">${icon('undo')}</button>
    <button class="icon" id="tb-redo" title="Yinele (üç parmakla dokun)">${icon('redo')}</button>
    <span class="spacer"></span>
    <button class="icon" id="tb-image" title="Resim ekle">${icon('image')}</button>
    <button class="icon" id="tb-search" title="Ara">${icon('search')}</button>
    <button class="icon" id="tb-overview" title="Tüm sayfalar">${icon('pages')}</button>
    <button class="icon" id="tb-page-menu" title="Sayfa işlemleri (sayfa ekle, çoğalt, sil)">${icon('more')}</button>
    <button class="icon" id="tb-finger" title="Parmakla çizim (kapalıyken parmak sayfayı kaydırır)">${icon('hand')}</button>
    <button class="icon" id="tb-export" title="PDF olarak dışa aktar">${icon('download')}</button>`;

  $('tb-back').onclick = () => onBack();
  $('tb-title').onclick = async () => {
    const title = await ui.promptModal({ title: 'Defteri yeniden adlandır', value: ed.nb.title, ok: 'Kaydet' });
    if (!title || !ed) return;
    ed.nb.title = title;
    $('tb-title').textContent = title;
    await saveNotebook();
  };
  tb.querySelectorAll('.tool').forEach((b) => {
    b.onclick = () => {
      if (settings.tool !== b.dataset.tool) {
        clearSelection();
        commitText();
      }
      if (active) finishActive(); // yarım kalan silgi / çizgi ekranda takılı kalmasın
      settings.tool = b.dataset.tool;
      saveSettings();
      updateToolbar();
    };
  });
  $('tb-fav').onclick = () => (favPop ? closeFavPop() : openFavPop($('tb-fav')));
  $('tb-undo').onclick = undo;
  $('tb-redo').onclick = redo;
  $('tb-image').onclick = () => $('image-input').click();
  $('image-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await insertImage(file);
  });
  $('tb-search').onclick = openSearch;
  // Yazı kutusu açıkken renk/boy düğmelerine dokunmak kutuyu kapatmasın (odak kutuda kalsın).
  tb.addEventListener('pointerdown', (e) => {
    if (textEdit && e.target.closest('#tb-colors, #tb-widths')) e.preventDefault();
  });
  $('tb-page-menu').onclick = pageMenu;
  $('tb-overview').onclick = openOverview;
  $('tb-finger').onclick = () => {
    settings.fingerDraw = !settings.fingerDraw;
    saveSettings();
    updateToolbar();
    ui.toast(settings.fingerDraw ? 'Parmakla çizim açık' : 'Parmak artık sayfayı kaydırır');
  };
  $('tb-export').onclick = exportPdf;
}

function updateToolbar() {
  const tool = settings.tool;
  document.querySelectorAll('#toolbar .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const colors = $('tb-colors');
  const widths = $('tb-widths');
  colors.innerHTML = '';
  widths.innerHTML = '';
  colors.hidden = widths.hidden = tool === 'lasso';
  $('tb-fav').hidden = tool === 'eraser' || tool === 'lasso' || tool === 'text';
  $('tb-fav').classList.toggle('active', !!favPop);
  $('tb-lasso-hint').hidden = tool !== 'lasso' || !!selection;
  if (tool === 'eraser') {
    // Silgi: "tüm çizgi" ya da "kısmi" ve üç boy
    for (const [mode, label] of [['stroke', 'Tüm çizgi'], ['partial', 'Kısmi']]) {
      const b = document.createElement('button');
      b.className = 'chip' + (settings.eraserMode === mode ? ' active' : '');
      b.textContent = label;
      b.title = mode === 'stroke' ? 'Dokunduğun çizginin tamamını siler' : 'Yalnızca üzerinden geçtiğin kısmı siler';
      b.onclick = () => {
        settings.eraserMode = mode;
        saveSettings();
        updateToolbar();
      };
      colors.append(b);
    }
    ERASER_SIZES.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'wbtn' + (settings.eraserSize === i ? ' active' : '');
      b.title = ['Küçük', 'Orta', 'Büyük'][i] + ' silgi';
      b.innerHTML = `<span class="eraser-dot" style="width:${6 + i * 6}px;height:${6 + i * 6}px"></span>`;
      b.onclick = () => {
        settings.eraserSize = i;
        saveSettings();
        updateToolbar();
      };
      widths.append(b);
    });
  } else if (tool === 'text') {
    // Metin: kalem renkleri ve dört yazı boyu
    PEN_COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (settings.textColor === i ? ' active' : '');
      b.style.setProperty('--c', c);
      b.title = 'Yazı rengi';
      b.onclick = () => {
        settings.textColor = i;
        saveSettings();
        updateToolbar();
        styleTextEditor();
      };
      colors.append(b);
    });
    colors.append(moreColorsButton('text'));
    TEXT_SIZES.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (settings.textSize === i ? ' active' : '');
      b.textContent = t.label;
      b.onclick = () => {
        settings.textSize = i;
        saveSettings();
        updateToolbar();
        styleTextEditor();
      };
      widths.append(b);
    });
  } else if (tool !== 'lasso') {
    const isHl = tool === 'hl';
    const palette = isHl ? HL_COLORS : PEN_COLORS;
    const colorKey = isHl ? 'hlColor' : 'penColor';
    palette.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (settings[colorKey] === i ? ' active' : '');
      b.style.setProperty('--c', c);
      b.title = 'Renk';
      b.onclick = () => {
        settings[colorKey] = i;
        saveSettings();
        updateToolbar();
      };
      colors.append(b);
    });
    colors.append(moreColorsButton(tool));
    const b = document.createElement('button');
    b.className = 'size-btn' + (sizePop ? ' active' : '');
    b.id = 'tb-size';
    b.title = 'Kalınlık';
    b.innerHTML = sizeDot(tool, sizeOf(tool), palette[settings[colorKey]]) + `<span class="size-val">${fmtSize(sizeOf(tool))}</span>`;
    b.onclick = () => (sizePop ? closeSizePop() : openSizePop(b));
    widths.append(b);
  }
  if (favPop && (tool === 'eraser' || tool === 'lasso' || tool === 'text')) closeFavPop();
  if (sizePop && sizePop.dataset.tool !== tool) closeSizePop();
  if (colorPop && (tool === 'eraser' || tool === 'lasso')) closeColorPop();
  else renderSizePop(); // renk değiştiyse önizleme de güncellensin
  $('tb-finger').classList.toggle('active', settings.fingerDraw);
  updateHistoryButtons();
}

// Her çizgiden sonra yalnızca geri al / yinele düğmeleri güncellenir (bütün araç çubuğu yeniden kurulmaz).
function updateHistoryButtons() {
  $('tb-undo').disabled = !ed?.undo.length;
  $('tb-redo').disabled = !ed?.redo.length;
}

/* ---------------- Kalınlık paneli ---------------- */

let sizePop = null;
const sizeOf = (tool) => (tool === 'hl' ? settings.hlSize : settings.penSize);
const fmtSize = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');
const currentColor = (tool) =>
  tool === 'hl' ? HL_COLORS[settings.hlColor] : tool === 'text' ? PEN_COLORS[settings.textColor] : PEN_COLORS[settings.penColor];

// Düğmedeki nokta, çizginin sayfadaki yaklaşık kalınlığını gösterir.
function sizeDot(tool, size, color) {
  const d = tool === 'hl' ? clamp(size * 0.7, 4, 24) : clamp(size * 2.6, 2, 22);
  const shape = tool === 'hl' ? `width:${d * 0.7}px;height:${d}px;border-radius:2px;opacity:.6` : `width:${d}px;height:${d}px`;
  return `<span class="dot" style="${shape};background:${color}"></span>`;
}

function setSize(tool, value) {
  const spec = SIZES[tool];
  value = Math.round(clamp(value, spec.min, spec.max) / spec.step) * spec.step;
  value = Math.round(value * 10) / 10;
  if (tool === 'hl') settings.hlSize = value;
  else settings.penSize = value;
  saveSettings();
  updateToolbar();
  renderSizePop();
}

function openSizePop(anchor) {
  const tool = settings.tool;
  sizePop = document.createElement('div');
  sizePop.className = 'size-pop';
  sizePop.dataset.tool = tool;
  const spec = SIZES[tool];
  sizePop.innerHTML = `<div class="size-head"><b>${spec.label}</b><span class="size-num"></span></div>
    <canvas class="size-preview" width="560" height="90"></canvas>
    <div class="size-presets"></div>
    <input class="size-range" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}">
    <div class="size-ends"><span>İnce</span><span>Kalın</span></div>`;
  const presets = sizePop.querySelector('.size-presets');
  for (const v of spec.presets) {
    const b = document.createElement('button');
    b.className = 'size-preset';
    b.dataset.v = v;
    b.title = fmtSize(v);
    b.onclick = () => setSize(tool, v);
    presets.append(b);
  }
  sizePop.querySelector('.size-range').addEventListener('input', (e) => setSize(tool, parseFloat(e.target.value)));
  document.body.append(sizePop);
  const r = anchor.getBoundingClientRect();
  const w = sizePop.offsetWidth;
  sizePop.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
  sizePop.style.top = r.bottom + 8 + 'px';
  renderSizePop();
  updateToolbar();
  setTimeout(() => document.addEventListener('pointerdown', onOutsideSizePop, true), 0);
}

function renderSizePop() {
  if (!sizePop) return;
  const tool = sizePop.dataset.tool;
  const size = sizeOf(tool);
  const color = currentColor(tool);
  sizePop.querySelector('.size-num').textContent = fmtSize(size);
  sizePop.querySelector('.size-range').value = size;
  sizePop.querySelectorAll('.size-preset').forEach((b) => {
    const v = parseFloat(b.dataset.v);
    b.classList.toggle('active', Math.abs(v - size) < 1e-6);
    b.innerHTML = sizeDot(tool, v, color);
  });
  // Önizleme: sayfada normal yakınlaştırmada nasıl görüneceğine yakın bir dalga çizgisi.
  const c = sizePop.querySelector('.size-preview');
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const k = 2.4; // önizleme ölçeği (piksel / pt)
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const x = 14 + i * 3.4;
    pts.push(x, 19 + Math.sin(i / 6) * 9, 0.35 + 0.4 * Math.sin((i / 60) * Math.PI));
  }
  drawStroke(ctx, { tool, color, width: size, pts });
}

function onOutsideSizePop(e) {
  if (!sizePop || sizePop.contains(e.target) || e.target.closest?.('#tb-size')) return;
  closeSizePop();
}

function closeSizePop() {
  document.removeEventListener('pointerdown', onOutsideSizePop, true);
  sizePop?.remove();
  sizePop = null;
  updateToolbar();
}

/* ---------------- Geri al / yinele ---------------- */

function pushUndo(op) {
  ed.undo.push(op);
  if (ed.undo.length > 300) ed.undo.shift();
  ed.redo.length = 0;
  updateHistoryButtons();
}

function viewById(pageId) {
  return ed.views.find((v) => v.page.id === pageId);
}

function applyOp(op, reverse) {
  const strokes = ed.ink.get(op.pageId);
  if (!strokes) return;
  if (op.type === 'add') {
    if (reverse) strokes.splice(strokes.indexOf(op.stroke), 1);
    else strokes.push(op.stroke);
  } else if (op.type === 'erase') {
    // Silinenler kaydedildikleri sıranın tersiyle eski yerlerine döner.
    if (reverse) for (let i = op.items.length - 1; i >= 0; i--) strokes.splice(op.items[i].index, 0, op.items[i].stroke);
    else for (const it of op.items) strokes.splice(strokes.indexOf(it.stroke), 1);
  } else if (op.type === 'snapshot') {
    // Kısmi silgi, taşıma, boyutlandırma, renk, çoğaltma: sayfanın önceki / sonraki hali
    strokes.splice(0, strokes.length, ...(reverse ? op.before : op.after));
  }
  viewById(op.pageId)?.drawInk();
  markDirty(op.pageId);
}

function undo() {
  const op = ed?.undo.pop();
  if (!op) return;
  clearSelection();
  applyOp(op, true);
  ed.redo.push(op);
  updateHistoryButtons();
}

function redo() {
  const op = ed?.redo.pop();
  if (!op) return;
  clearSelection();
  applyOp(op, false);
  ed.undo.push(op);
  updateHistoryButtons();
}

/* ---------------- Kalem, silgi, parmakla kaydırma ---------------- */

let active = null; // o an çizilen çizgi ya da silgi hareketi
const touches = new Map();
let pinch = null;
let lastPen = -Infinity;
let velSamples = [];
let inertiaRaf = 0;
let liveRaf = 0;

function bindInput() {
  pagesEl.addEventListener('pointerdown', onDown);
  pagesEl.addEventListener('pointermove', onMove);
  pagesEl.addEventListener('pointerup', onUp);
  pagesEl.addEventListener('pointercancel', onUp);
  pagesEl.addEventListener('contextmenu', (e) => e.preventDefault());
  pagesEl.addEventListener(
    'wheel',
    (e) => {
      if (!ed || !e.ctrlKey) return;
      e.preventDefault();
      setZoom(ed.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
    },
    { passive: false },
  );
  pagesEl.addEventListener('scroll', () => {
    if (!indicatorRaf) indicatorRaf = requestAnimationFrame(updateIndicator);
    if (ed) scheduleSharp();
  });
  document.addEventListener('keydown', (e) => {
    if (!ed || !(e.ctrlKey || e.metaKey) || e.target.closest?.('input')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });
}

function onDown(e) {
  if (!ed || e.target.closest('button')) return;
  if (e.target.closest('.text-editor')) return; // yazı kutusunun içinde imleç yerleştirme
  const now = performance.now();
  // Seçimi parmakla da sürükleyebilmek için: seçim kutusuna dokunuş kaydırma sayılmaz.
  const onSelection = selection && e.target.closest('.sel-box');
  if (e.pointerType === 'touch' && !settings.fingerDraw && !onSelection) {
    if (active || now - lastPen < PALM_GUARD_MS) return;
    startTouch(e);
    return;
  }
  if (e.pointerType === 'pen') lastPen = now;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // Kalemin kalkışı bazen tablete ulaşmıyor: eski iz (ör. silgi halkası) ekranda takılı kalmasın, yeni dokunuş onu bitirsin.
  if (active && e.pointerType === 'pen' && e.pointerId !== active.id) finishActive();
  if (active) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  e.preventDefault();
  // Kalem değdiyse avuç içinden gelen kaydırmayı bırak.
  touches.clear();
  pinch = null;
  tap = null;
  stopInertia();
  capture(e.pointerId);
  const v = pageEl._view;
  const rect = pageEl.getBoundingClientRect();
  const penButton =
    settings.penButtonEraser && e.pointerType === 'pen' && (e.button === 5 || e.button === 2 || (e.buttons & 32) || (e.buttons & 2));
  const base = { id: e.pointerId, v, rect, k: v.page.w / rect.width, cursor: null };
  const at = pagePoint(e, base);

  if (onSelection && selection.v === v) {
    startSelectionDrag(e, base, at, e.target.closest('.sel-handle') ? 'resize' : 'move');
    return;
  }
  if (settings.tool === 'text' && !penButton) {
    clearSelection();
    startTextAt(v, at.x, at.y);
    return;
  }
  commitText();
  if (settings.tool === 'lasso' && !penButton) {
    clearSelection();
    active = { ...base, kind: 'lasso', poly: [at.x, at.y] };
    attachLive(v);
    requestLive();
    return;
  }
  clearSelection();
  if (settings.tool === 'eraser' || penButton) {
    active = { ...base, kind: 'erase', erased: [], before: v.strokes.slice(), changed: false };
    attachLive(v);
    eraseAt(e);
  } else {
    const hl = settings.tool === 'hl';
    active = {
      ...base,
      kind: 'ink',
      stroke: { tool: hl ? 'hl' : 'pen', color: currentColor(settings.tool), width: hl ? settings.hlSize : settings.penSize, pts: [] },
      hold: null,
      snapped: false,
    };
    attachLive(v);
    addPoint(e, true);
    holdCheck(e);
  }
  requestLive();
}

function pagePoint(ev, a = active) {
  return { x: (ev.clientX - a.rect.left) * a.k, y: (ev.clientY - a.rect.top) * a.k };
}

function onMove(e) {
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (active && e.pointerId === active.id) {
    if (active.kind === 'move' || active.kind === 'resize') {
      dragSelection(e);
      return;
    }
    const coalesced = e.getCoalescedEvents?.() || [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      if (active.kind === 'erase') eraseAt(ev);
      else if (active.kind === 'lasso') lassoPoint(ev);
      else if (!active.snapped) addPoint(ev, false);
    }
    if (active.kind === 'ink') holdCheck(e);
    requestLive();
    return;
  }
  if (touches.has(e.pointerId)) moveTouch(e);
}

function onUp(e) {
  if (active && e.pointerId === active.id) {
    finishActive();
    return;
  }
  if (touches.has(e.pointerId)) endTouch(e);
}

function addPoint(ev, force) {
  const a = active;
  const { x, y } = pagePoint(ev);
  let p = ev.pointerType === 'pen' && settings.pressure ? ev.pressure : 0.5;
  if (!(p > 0)) p = 0.3;
  const pts = a.stroke.pts;
  const n = pts.length;
  if (!force && n) {
    const dx = x - pts[n - 3];
    const dy = y - pts[n - 2];
    if (dx * dx + dy * dy < 0.09) return;
  }
  pts.push(round2(x), round2(y), round2(p));
}

// Kalem bir yerde bekletilirse (SHAPE_HOLD_MS) çizgiyi düzgün şekle çevir.
function holdCheck(ev) {
  const a = active;
  if (!a || a.kind !== 'ink' || a.snapped || !settings.shapeSnap) return;
  const h = a.hold;
  if (h && Math.hypot(ev.clientX - h.x, ev.clientY - h.y) <= 4) return;
  clearTimeout(h?.timer);
  a.hold = { x: ev.clientX, y: ev.clientY, timer: setTimeout(() => trySnap(a), SHAPE_HOLD_MS) };
}

function trySnap(a) {
  if (active !== a || a.snapped || a.stroke.pts.length < 15) return;
  const pts = recognizeShape(a.stroke.pts);
  if (!pts) return;
  a.stroke.pts = pts;
  a.snapped = true;
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(12); // şekle dönüştü: kısa titreşim
  requestLive();
}

function eraseAt(ev) {
  const a = active;
  const { x, y } = pagePoint(ev);
  const r = eraserRadius() * a.k;
  // Silgi hızlı hareket ettiğinde iki olay arasında kalan yeri de tara (aradaki çizgiler atlanmasın).
  const prev = a.cursor;
  a.cursor = { x, y };
  if (prev) {
    const steps = Math.floor(Math.hypot(x - prev.x, y - prev.y) / (r / 2));
    for (let i = 1; i < steps; i++) eraseAtPoint(a, prev.x + ((x - prev.x) * i) / steps, prev.y + ((y - prev.y) * i) / steps, r);
  }
  eraseAtPoint(a, x, y, r);
}

function eraseAtPoint(a, x, y, r) {
  const strokes = a.v.strokes;
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (settings.eraserMode === 'partial') {
      const pieces = eraseFromStroke(strokes[i], x, y, r);
      if (pieces) {
        strokes.splice(i, 1, ...pieces);
        changed = true;
      }
    } else if (hitStroke(strokes[i], x, y, r)) {
      a.erased.push({ stroke: strokes[i], index: i });
      strokes.splice(i, 1);
      changed = true;
    }
  }
  // Sayfa her dokunuşta değil, ekran yenilenirken bir kez yeniden çizilir (drawLive); kayıt silgi kalkınca.
  if (changed) a.changed = a.redraw = true;
}

function lassoPoint(ev) {
  const { x, y } = pagePoint(ev);
  const poly = active.poly;
  const n = poly.length;
  if (Math.hypot(x - poly[n - 2], y - poly[n - 1]) > 1.5) poly.push(round2(x), round2(y));
}

function finishActive() {
  const a = active;
  active = null;
  clearTimeout(a.hold?.timer);
  // Canlı katman sayfada kalır, yalnızca temizlenir: her çizgide tuvali sayfaya ekleyip çıkarmak tarayıcıyı yoruyordu.
  const lctx = liveCanvas.getContext('2d');
  lctx.setTransform(1, 0, 0, 1, 0, 0); // son çizimin ölçeği kalmışsa tuvalin bir kısmı silinmeden kalıyordu
  lctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  const pageId = a.v.page.id;
  if (a.kind === 'ink' && a.stroke.pts.length) {
    a.v.strokes.push(a.stroke);
    a.v.addStroke(a.stroke);
    pushUndo({ type: 'add', pageId, stroke: a.stroke });
    markDirty(pageId);
  } else if (a.kind === 'erase' && a.changed) {
    if (a.redraw) a.v.drawInk();
    markDirty(pageId);
    if (settings.eraserMode === 'partial') pushUndo({ type: 'snapshot', pageId, before: a.before, after: a.v.strokes.slice() });
    else pushUndo({ type: 'erase', pageId, items: a.erased });
  } else if (a.kind === 'lasso') {
    finishLasso(a);
  } else if (a.kind === 'move' || a.kind === 'resize') {
    finishSelectionDrag(a);
  }
}

let liveRegion = null; // canlı katmanın sayfadaki yeri ve ölçeği
function attachLive(v) {
  let w, h;
  const view = v.needsSharp() && visibleRegion(v, 0);
  if (view) {
    // Büyük / yakınlaştırılmış sayfa: canlı katman yalnızca görünen kısmı, ekranın tam çözünürlüğünde kaplar.
    liveRegion = regionAt(view, ed.pxPerPt * (window.devicePixelRatio || 1));
    placeSharp(liveCanvas, liveRegion, v.page);
    w = liveRegion.cw;
    h = liveRegion.ch;
  } else {
    ({ w, h } = v.inkSize || v.targetSize()); // canlı katman da aynı boyut sınırına uyar
    liveRegion = { S: w / v.page.w, ox: 0, oy: 0 };
    liveCanvas.style.cssText = '';
  }
  if (liveCanvas.width !== w || liveCanvas.height !== h) {
    liveCanvas.width = w;
    liveCanvas.height = h;
  }
  liveCanvas.getContext('2d').clearRect(0, 0, w, h);
  if (liveCanvas.parentNode !== v.el) v.el.append(liveCanvas);
}

function requestLive() {
  if (!liveRaf) liveRaf = requestAnimationFrame(drawLive);
}

function drawLive() {
  liveRaf = 0;
  if (!active) return;
  if (active.redraw) {
    active.redraw = false;
    active.v.drawInk();
  }
  const ctx = liveCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  ctx.setTransform(liveRegion.S, 0, 0, liveRegion.S, -liveRegion.ox, -liveRegion.oy);
  if (active.kind === 'ink') drawStroke(ctx, active.stroke);
  if (active.kind === 'erase' && active.cursor) {
    ctx.beginPath();
    ctx.arc(active.cursor.x, active.cursor.y, eraserRadius() * active.k, 0, Math.PI * 2);
    ctx.lineWidth = active.k;
    ctx.strokeStyle = 'rgba(100,116,139,.9)';
    ctx.fillStyle = 'rgba(148,163,184,.15)';
    ctx.fill();
    ctx.stroke();
  }
  if (active.kind === 'lasso') {
    const p = active.poly;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,.06)';
    ctx.fill();
    ctx.setLineDash([4 * active.k, 3 * active.k]);
    ctx.lineWidth = 1.4 * active.k;
    ctx.strokeStyle = '#2563eb';
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (active.kind === 'move' || active.kind === 'resize') drawStrokes(ctx, active.preview);
}

/* ---------------- Kement: seçim, taşıma, boyutlandırma ---------------- */

let selection = null; // { v, strokes: [], box, el, bar }
let clipboard = null; // kopyalanan çizgiler (başka sayfaya yapıştırmak için)

function finishLasso(a) {
  if (a.poly.length < 6) return;
  const picked = a.v.strokes.filter((s) => strokeInPolygon(s, a.poly));
  if (!picked.length) {
    ui.toast('Seçim alanında yazı yok');
    return;
  }
  selectStrokes(a.v, picked);
}

function selectStrokes(v, strokes) {
  clearSelection();
  selection = { v, strokes, box: strokesBounds(strokes), el: null, bar: null };
  renderSelection();
  updateToolbar();
}

function clearSelection() {
  if (!selection) return;
  selection.el?.remove();
  selection.bar?.remove();
  selection = null;
  if (ed) updateToolbar();
}

// Seçim kutusu sayfanın içine yüzde ile yerleştirilir: yakınlaştırınca kendiliğinden ölçeklenir.
function renderSelection(box = selection.box) {
  const { v } = selection;
  const pct = (val, total) => (val / total) * 100 + '%';
  const pad = 4;
  if (!selection.el) {
    selection.el = document.createElement('div');
    selection.el.className = 'sel-box';
    selection.el.innerHTML = '<span class="sel-handle" title="Sürükleyerek büyüt / küçült"></span>';
    selection.bar = document.createElement('div');
    selection.bar.className = 'sel-bar';
    selection.bar.innerHTML = `
      <button data-a="color" title="Rengini değiştir">${icon('palette')}<span>Renk</span></button>
      <button data-a="copy" title="Kopyala (başka sayfaya yapıştırmak için)">${icon('copy')}<span>Kopyala</span></button>
      <button data-a="dup" title="Çoğalt">${icon('plus')}<span>Çoğalt</span></button>
      <button data-a="delete" class="danger" title="Sil">${icon('trash')}<span>Sil</span></button>`;
    selection.bar.addEventListener('click', onSelectionAction);
    v.el.append(selection.el, selection.bar);
  }
  Object.assign(selection.el.style, {
    left: pct(box.x - pad, v.page.w),
    top: pct(box.y - pad, v.page.h),
    width: pct(box.w + pad * 2, v.page.w),
    height: pct(box.h + pad * 2, v.page.h),
  });
  const above = box.y - pad > 60;
  selection.bar.classList.toggle('below', !above);
  Object.assign(selection.bar.style, {
    left: pct(box.x + box.w / 2, v.page.w),
    top: above ? pct(box.y - pad, v.page.h) : pct(box.y + box.h + pad, v.page.h),
  });
}

function startSelectionDrag(e, base, at, kind) {
  const s = selection;
  active = { ...base, kind, start: at, preview: s.strokes, box: s.box, t: null };
  // Taşınırken seçili çizgiler sayfadan gizlenip canlı katmanda çizilir.
  s.v.drawInk(new Set(s.strokes));
  attachLive(s.v);
  s.bar.hidden = true;
  requestLive();
}

function selectionTransform(a, at) {
  const b = a.box;
  if (a.kind === 'move') return { dx: at.x - a.start.x, dy: at.y - a.start.y };
  // Sağ alt köşeden tek oranla (en-boy oranı korunarak) büyüt / küçült; sol üst köşe sabit.
  const k = clamp((at.x - b.x + (at.y - b.y)) / (b.w + b.h || 1), 0.15, 8);
  return { k, ax: b.x, ay: b.y };
}

function dragSelection(e) {
  const a = active;
  const t = selectionTransform(a, pagePoint(e));
  a.t = t;
  a.preview = selection.strokes.map((s) => transformStroke(s, t));
  const b = a.box;
  renderSelection(t.k ? { x: b.x, y: b.y, w: b.w * t.k, h: b.h * t.k } : { x: b.x + t.dx, y: b.y + t.dy, w: b.w, h: b.h });
  requestLive();
}

function finishSelectionDrag(a) {
  const s = selection;
  s.bar.hidden = false;
  const moved = a.t && (a.kind === 'resize' ? Math.abs(a.t.k - 1) > 0.005 : Math.hypot(a.t.dx, a.t.dy) >= 0.5);
  if (!moved) {
    s.v.drawInk();
    renderSelection();
    return;
  }
  replaceStrokes(s.v, s.strokes, a.preview);
  selectStrokes(s.v, a.preview);
}

// Çizgileri yenileriyle (aynı sırada; null = sil) değiştirir ve tek adımda geri alınabilir yapar.
function replaceStrokes(v, oldOnes, newOnes) {
  const strokes = v.strokes;
  const before = strokes.slice();
  const map = new Map(oldOnes.map((s, i) => [s, newOnes[i]]));
  const after = [];
  for (const s of strokes) {
    if (!map.has(s)) after.push(s);
    else if (map.get(s)) after.push(map.get(s));
  }
  strokes.splice(0, strokes.length, ...after);
  pushUndo({ type: 'snapshot', pageId: v.page.id, before, after: after.slice() });
  v.drawInk();
  markDirty(v.page.id);
}

async function onSelectionAction(e) {
  const btn = e.target.closest('button');
  if (!btn || !selection) return;
  const { v, strokes } = selection;
  const action = btn.dataset.a;
  if (action === 'delete') {
    replaceStrokes(
      v,
      strokes,
      strokes.map(() => null),
    );
    clearSelection();
    ui.toast('Silindi');
  } else if (action === 'copy') {
    clipboard = structuredClone(strokes);
    ui.toast('Kopyalandı. Başka sayfada ⋮ menüsünden "Yapıştır"ı seç.');
  } else if (action === 'dup') {
    addStrokes(
      v,
      strokes.map((s) => transformStroke(s, { dx: 18, dy: 18 })),
    );
  } else if (action === 'color') {
    const color = await pickSelectionColor(btn);
    if (!color || !selection) return;
    const recolored = strokes.map((s) => ({ ...s, color }));
    replaceStrokes(v, strokes, recolored);
    selectStrokes(v, recolored);
  }
}

function addStrokes(v, newOnes) {
  const strokes = v.strokes;
  const before = strokes.slice();
  strokes.push(...newOnes);
  pushUndo({ type: 'snapshot', pageId: v.page.id, before, after: strokes.slice() });
  v.drawInk();
  markDirty(v.page.id);
  if (settings.tool !== 'lasso') {
    settings.tool = 'lasso';
    saveSettings();
  }
  selectStrokes(v, newOnes);
}

function pasteClipboard(idx) {
  if (!clipboard?.length || !ed) return;
  const v = ed.views[idx];
  // Yapıştırılan yazı sayfanın dışına taşmasın.
  const b = strokesBounds(clipboard);
  const dx = clamp(0, -b.x + 8, v.page.w - b.x - b.w - 8);
  const dy = clamp(0, -b.y + 8, v.page.h - b.y - b.h - 8);
  addStrokes(
    v,
    clipboard.map((s) => transformStroke(s, { dx, dy })),
  );
  ui.toast('Yapıştırıldı');
}

function pickSelectionColor(anchor) {
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'color-pop';
    for (const c of [...new Set([...PEN_COLORS, ...PEN_PRESETS, ...HL_COLORS])]) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--c', c);
      b.onclick = () => done(c);
      pop.append(b);
    }
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = clamp(r.left, 8, window.innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    const outside = (ev) => {
      if (!pop.contains(ev.target)) done(null);
    };
    const done = (c) => {
      document.removeEventListener('pointerdown', outside, true);
      pop.remove();
      resolve(c);
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  });
}

/* ---------------- Renk seçici ---------------- */

const paletteKey = (tool) => (tool === 'hl' ? 'hlColor' : tool === 'text' ? 'textColor' : 'penColor');
const paletteOf = (tool) => (tool === 'hl' ? HL_COLORS : PEN_COLORS);

// Aracın rengini ayarla: renk kutularında varsa onu seç, yoksa işaretli kutunun yerine koy.
function setToolColor(tool, hex) {
  const palette = paletteOf(tool);
  const key = paletteKey(tool);
  const i = palette.findIndex((c) => c.toLowerCase() === hex.toLowerCase());
  if (i >= 0) settings[key] = i;
  else palette[settings[key]] = hex;
  saveSettings();
  updateToolbar();
  styleTextEditor();
}

let colorPop = null;

function openColorPop(anchor, tool) {
  closeColorPop();
  const presets = tool === 'hl' ? HL_PRESETS : PEN_PRESETS;
  colorPop = document.createElement('div');
  colorPop.className = 'fav-pop color-picker-pop';
  colorPop.innerHTML = `<div class="size-head"><b>Renk seç</b></div>
    <p class="fav-empty">Seçtiğin renk, araç çubuğunda işaretli olan kutunun yerine geçer.</p>
    <div class="color-grid-pop"></div>
    <div class="color-pop-foot">
      <label class="btn custom-color">${icon('palette')}<span>Özel renk…</span><input type="color"></label>
      <button class="btn ghost" data-a="reset">Varsayılan renkler</button>
    </div>`;
  const grid = colorPop.querySelector('.color-grid-pop');
  const current = currentColor(tool).toLowerCase();
  for (const c of presets) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c.toLowerCase() === current ? ' active' : '');
    b.style.setProperty('--c', c);
    b.title = c;
    b.onclick = () => {
      setToolColor(tool, c);
      closeColorPop();
    };
    grid.append(b);
  }
  const input = colorPop.querySelector('input[type=color]');
  input.value = current.length === 7 ? current : '#000000';
  input.addEventListener('change', () => {
    setToolColor(tool, input.value);
    closeColorPop();
  });
  colorPop.querySelector('[data-a=reset]').onclick = () => {
    const defaults = tool === 'hl' ? DEFAULT_HL_COLORS : DEFAULT_PEN_COLORS;
    paletteOf(tool).splice(0, 5, ...defaults);
    saveSettings();
    updateToolbar();
    closeColorPop();
    ui.toast('Renkler varsayılana döndü');
  };
  // Yazı kutusu açıkken renge dokunmak kutuyu kapatmasın (odak kutuda kalsın).
  colorPop.addEventListener('pointerdown', (e) => {
    if (textEdit && !e.target.closest('input, label')) e.preventDefault();
  });
  document.body.append(colorPop);
  const r = anchor.getBoundingClientRect();
  colorPop.style.left = clamp(r.left + r.width / 2 - colorPop.offsetWidth / 2, 8, window.innerWidth - colorPop.offsetWidth - 8) + 'px';
  colorPop.style.top = r.bottom + 8 + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onOutsideColorPop, true), 0);
}

function onOutsideColorPop(e) {
  if (!colorPop || colorPop.contains(e.target) || e.target.closest?.('#tb-more-colors')) return;
  closeColorPop();
}

function closeColorPop() {
  document.removeEventListener('pointerdown', onOutsideColorPop, true);
  colorPop?.remove();
  colorPop = null;
}

function moreColorsButton(tool) {
  const b = document.createElement('button');
  b.className = 'icon more-colors';
  b.id = 'tb-more-colors';
  b.title = 'Daha fazla renk';
  b.innerHTML = icon('plus');
  b.onclick = () => (colorPop ? closeColorPop() : openColorPop(b, tool));
  return b;
}

/* ---------------- Ayarlar ---------------- */

export function openSettings({ onClose } = {}) {
  const change = (key, value) => {
    settings[key] = value;
    saveSettings();
    if (ed) updateToolbar();
  };
  ui.settingsModal({
    title: 'Ayarlar',
    groups: [
      {
        title: 'Dokunma hareketleri',
        items: [
          { key: 'gestureUndo', label: 'İki parmakla dokun: geri al', desc: 'Kapalıyken elin ekrana değince yanlışlıkla geri almaz.', value: settings.gestureUndo },
          { key: 'gestureRedo', label: 'Üç parmakla dokun: yinele', value: settings.gestureRedo },
          { key: 'fingerDraw', label: 'Parmakla çizim', desc: 'Açıkken parmak da çizer; kapalıyken parmak sayfayı kaydırır.', value: settings.fingerDraw },
          { key: 'pageDrag', label: 'Sayfaları sürükleyerek taşı', desc: 'Tüm sayfalar ekranında tutamaktan sürükleyip sırayı değiştirir.', value: settings.pageDrag },
        ],
      },
      {
        title: 'Kalem',
        items: [
          { key: 'pressure', label: 'Basınca duyarlı kalınlık', desc: 'Kapalıyken çizgi her yerde aynı kalınlıkta olur.', value: settings.pressure },
          { key: 'shapeSnap', label: 'Bekletince şekle dönüştür', desc: 'Çizginin sonunda kalemi bekletince düz çizgi, daire, dikdörtgen olur.', value: settings.shapeSnap },
          { key: 'penButtonEraser', label: 'Kalem düğmesi silgi olsun', desc: 'Kalemin yan düğmesine basılıyken silgi gibi siler.', value: settings.penButtonEraser },
        ],
      },
      {
        title: 'Kitaplık',
        items: [{ key: 'backupReminder', label: 'Yedek hatırlatıcısı', desc: 'Değişiklik varsa 3 günde bir yedek almayı hatırlatır.', value: settings.backupReminder }],
      },
    ],
    onChange: change,
  }).then(() => onClose?.());
}

/* ---------------- Favori kalemler ---------------- */

let favPop = null;

const favKey = (f) => `${f.tool}|${f.hex}|${f.size}`;

function openFavPop(anchor) {
  favPop = document.createElement('div');
  favPop.className = 'fav-pop';
  document.body.append(favPop);
  renderFavPop();
  const r = anchor.getBoundingClientRect();
  favPop.style.left = clamp(r.left + r.width / 2 - favPop.offsetWidth / 2, 8, window.innerWidth - favPop.offsetWidth - 8) + 'px';
  favPop.style.top = r.bottom + 8 + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onOutsideFavPop, true), 0);
  updateToolbar();
}

function renderFavPop() {
  if (!favPop) return;
  const cur = { tool: settings.tool, hex: currentColor(settings.tool), size: sizeOf(settings.tool) };
  const favs = settings.favorites;
  favPop.innerHTML = `<div class="size-head"><b>Favori kalemler</b></div><div class="fav-list"></div>
    <button class="btn fav-add">${icon('plus')}<span>Şu anki kalemi ekle</span></button>`;
  const list = favPop.querySelector('.fav-list');
  if (!favs.length) list.innerHTML = '<p class="fav-empty">Sık kullandığın renk ve kalınlığı buraya ekle, tek dokunuşla geç.</p>';
  favs.forEach((f, i) => {
    const color = f.hex;
    const name = f.tool === 'hl' ? 'Fosforlu' : 'Kalem';
    const item = document.createElement('div');
    item.className = 'fav' + (favKey(f) === favKey(cur) ? ' active' : '');
    item.innerHTML = `<button class="fav-use">${sizeDot(f.tool, f.size, color)}<span>${name} · ${fmtSize(f.size)}</span></button>
      <button class="fav-del" title="Favorilerden çıkar">${icon('close')}</button>`;
    item.querySelector('.fav-use').onclick = () => {
      settings.tool = f.tool;
      if (f.tool === 'hl') settings.hlSize = f.size;
      else settings.penSize = f.size;
      setToolColor(f.tool, f.hex);
      closeFavPop();
    };
    item.querySelector('.fav-del').onclick = () => {
      settings.favorites.splice(i, 1);
      saveSettings();
      renderFavPop();
    };
    list.append(item);
  });
  const add = favPop.querySelector('.fav-add');
  add.disabled = favs.some((f) => favKey(f) === favKey(cur)) || favs.length >= MAX_FAVORITES;
  add.onclick = () => {
    settings.favorites.push(cur);
    saveSettings();
    renderFavPop();
  };
}

function onOutsideFavPop(e) {
  if (!favPop || favPop.contains(e.target) || e.target.closest?.('#tb-fav')) return;
  closeFavPop();
}

function closeFavPop() {
  document.removeEventListener('pointerdown', onOutsideFavPop, true);
  favPop?.remove();
  favPop = null;
  updateToolbar();
}

// Parmak hareketleri tarayıcıya bırakılmıyor (touch-action: none), çünkü kalemle yazarken sayfanın
// kaymaması gerekiyor. Bu yüzden kaydırma, iki parmakla yakınlaştırma ve kayma ataleti burada yapılıyor.
// Çok parmakla kısa dokunuş: 2 parmak = geri al, 3 parmak = yinele (GoodNotes'taki gibi).
const TAP_MAX_MS = 350;
const TAP_MAX_MOVE = 14;
let tap = null; // { start, max, moved, zoom, origins: Map }

function startTouch(e) {
  capture(e.pointerId);
  stopInertia();
  setPull(0);
  // Çekme yalnızca parmak zaten en alttayken konduysa başlar; hızlı kaydırırken sona çarpmak sayfa eklemesin.
  if (touches.size === 0) pullArmed = isAtBottom();
  if (touches.size === 0) tap = { start: performance.now(), max: 0, moved: false, zoom: ed.zoom, origins: new Map() };
  if (tap) {
    tap.origins.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap.max = Math.max(tap.max, touches.size + 1);
  }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  velSamples = [];
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: ed.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
}

function moveTouch(e) {
  const prev = touches.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  touches.set(e.pointerId, cur);
  const o = tap?.origins.get(e.pointerId);
  if (o && !tap.moved && Math.hypot(cur.x - o.x, cur.y - o.y) > TAP_MAX_MOVE) {
    tap.moved = true;
    // Dokunuş değil hareketmiş: yakınlaştırmayı parmakların şu anki konumundan başlat (sıçrama olmasın).
    if (touches.size >= 2) {
      const [a, b] = [...touches.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: ed.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
  }
  // Dokunuş olarak kalacaksa sayfayı oynatma (iki parmağın minik kayması yakınlaştırma yapmasın).
  if (tap && !tap.moved && tap.max >= 2) return;
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    pagesEl.scrollLeft -= cx - pinch.cx;
    pagesEl.scrollTop -= cy - pinch.cy;
    pinch.cx = cx;
    pinch.cy = cy;
    setZoom((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist, cx, cy);
  } else if (touches.size === 1) {
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    // Son sayfanın sonundayken parmak yukarı çekmeye devam ederse "yeni sayfa" çekmesi başlar.
    if (pull > 0 || (pullArmed && dy < 0 && isAtBottom())) {
      setPull(Math.max(0, pull - dy));
      if (pull > 0) {
        pagesEl.scrollLeft -= dx;
        velSamples = [];
        return;
      }
    }
    pagesEl.scrollLeft -= dx;
    pagesEl.scrollTop -= dy;
    const t = performance.now();
    velSamples.push({ t, dx, dy });
    while (velSamples.length && t - velSamples[0].t > 100) velSamples.shift();
  }
}

function endTouch(e) {
  touches.delete(e.pointerId);
  if (touches.size === 0 && tap) {
    const t = tap;
    tap = null;
    // Metin aracında parmakla tek dokunuş da yazı kutusu açar.
    if (settings.tool === 'text' && t.max === 1 && !t.moved && performance.now() - t.start <= TAP_MAX_MS) {
      const o = [...t.origins.values()][0];
      const pageEl = document.elementFromPoint(o.x, o.y)?.closest('.page');
      if (pageEl) {
        const r = pageEl.getBoundingClientRect();
        const k = pageEl._view.page.w / r.width;
        setTimeout(() => startTextAt(pageEl._view, (o.x - r.left) * k, (o.y - r.top) * k), 0);
      }
      return;
    }
    if (!t.moved && t.max >= 2 && performance.now() - t.start <= TAP_MAX_MS) {
      pinch = null;
      // Ayarlardan kapatıldıysa dokunuş hiçbir şey yapmaz (eli yanlışlıkla değince geri almasın).
      if (t.max === 2) {
        if (settings.gestureUndo && ed.undo.length) {
          undo();
          ui.toast('Geri alındı');
        }
      } else if (settings.gestureRedo && ed.redo.length) {
        redo();
        ui.toast('Yinelendi');
      }
      return;
    }
  }
  if (pinch) {
    if (touches.size < 2) {
      pinch = null;
      velSamples = [];
    }
    return;
  }
  if (touches.size) return;
  if (pull > 0) {
    const enough = pull >= PULL_ADD_PX;
    setPull(0);
    if (enough) addPageAtEnd();
    return;
  }
  const t = performance.now();
  const recent = velSamples.filter((s) => t - s.t < 100);
  if (recent.length < 2) return;
  const dt = Math.max(16, t - recent[0].t);
  startInertia(recent.reduce((s, r) => s + r.dx, 0) / dt, recent.reduce((s, r) => s + r.dy, 0) / dt);
}

// Sona çekerek sayfa ekleme (diğer not uygulamalarındaki gibi)
const PULL_ADD_PX = 110; // bu kadar çekip bırakınca sayfa eklenir
let pull = 0;
let pullEl = null;
let pullArmed = false;
const isAtBottom = () => pagesEl.scrollTop >= pagesEl.scrollHeight - pagesEl.clientHeight - 2;

function setPull(px) {
  pull = px;
  if (!pullEl) return;
  const ready = pull >= PULL_ADD_PX;
  pullEl.classList.toggle('show', pull > 0);
  pullEl.classList.toggle('ready', ready);
  pullEl.textContent = ready ? 'Bırak: yeni sayfa eklenecek' : 'Yeni sayfa için çekmeye devam et';
  // Sayfalar parmağı biraz takip etsin (lastik etkisi)
  sheetEl.style.transform = pull > 0 ? `translateY(${-Math.min(pull, PULL_ADD_PX * 1.4) * 0.45}px)` : '';
}

function addPageAtEnd() {
  const last = ed.nb.pages[ed.nb.pages.length - 1];
  // Son sayfa boş bir sayfaysa aynı şablon; PDF'in sonundaysa en son seçilen şablon
  const template = last.kind === 'pdf' ? loadJSON('nd-template', { template: 'blank' }).template : last.template || 'blank';
  insertBlank(ed.nb.pages.length, template);
}

function startInertia(vx, vy) {
  if (Math.hypot(vx, vy) < 0.1) return;
  let last = performance.now();
  const step = (t) => {
    const dt = Math.min(48, t - last);
    last = t;
    pagesEl.scrollLeft -= vx * dt;
    pagesEl.scrollTop -= vy * dt;
    const decay = Math.pow(0.995, dt);
    vx *= decay;
    vy *= decay;
    inertiaRaf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  inertiaRaf = requestAnimationFrame(step);
}

function capture(pointerId) {
  try {
    pagesEl.setPointerCapture(pointerId);
  } catch {
    /* işaretçi bu arada kalktıysa yakalamaya gerek yok */
  }
}

function stopInertia() {
  if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
  inertiaRaf = 0;
}

// O an sayfadan gizlenmesi gereken öğeler: düzenlenen yazı kutusu ya da sürüklenen seçim.
function selectionHidden(v) {
  const hide = new Set();
  if (textEdit?.v === v && textEdit.item) hide.add(textEdit.item);
  if (active && (active.kind === 'move' || active.kind === 'resize') && selection?.v === v) selection.strokes.forEach((s) => hide.add(s));
  return hide.size ? hide : undefined;
}

/* ---------------- Metin kutusu ---------------- */

let textEdit = null; // { v, x, y, w, item (düzenlenen eski kutu ya da null), el }

// Sayfada (x, y) noktasına dokunuldu: oradaki metin kutusunu düzenle ya da yeni kutu aç.
function startTextAt(v, x, y) {
  commitText();
  const existing = [...v.strokes].reverse().find((s) => s.tool === 'text' && x >= s.pts[0] && x <= s.pts[3] && y >= s.pts[1] && y <= s.pts[4]);
  const size = existing ? existing.width : TEXT_SIZES[settings.textSize].size;
  const w = existing ? existing.pts[3] - existing.pts[0] : Math.max(80, Math.min(320, v.page.w - x - 24));
  const el = document.createElement('textarea');
  el.className = 'text-editor';
  el.spellcheck = true;
  el.value = existing?.text || '';
  el.placeholder = 'Yazmaya başla…';
  textEdit = {
    v,
    x: existing ? existing.pts[0] : x,
    y: existing ? existing.pts[1] : y - size * 0.7,
    w,
    item: existing,
    el,
    size,
    color: existing ? existing.color : PEN_COLORS[settings.textColor],
  };
  if (existing) {
    // Düzenlenen kutunun rengi / boyu araç çubuğunda görünsün.
    const ci = PEN_COLORS.indexOf(existing.color);
    if (ci >= 0) settings.textColor = ci;
    const si = TEXT_SIZES.findIndex((t) => t.size === existing.width);
    if (si >= 0) settings.textSize = si;
    updateToolbar();
    v.drawInk(new Set([existing]));
  }
  el.addEventListener('input', autoGrowText);
  el.addEventListener('blur', () => setTimeout(() => textEdit?.el === el && document.activeElement !== el && commitText(), 0));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.blur();
  });
  v.el.append(el);
  styleTextEditor(false);
  el.focus();
}

// applySettings: araç çubuğundan seçilen renk / boy yazılan kutuya uygulansın.
function styleTextEditor(applySettings = true) {
  if (!textEdit) return;
  const { v, el } = textEdit;
  if (applySettings) {
    textEdit.size = TEXT_SIZES[settings.textSize].size;
    textEdit.color = PEN_COLORS[settings.textColor];
  }
  const pct = (val, total) => (val / total) * 100 + '%';
  Object.assign(el.style, {
    left: pct(textEdit.x, v.page.w),
    top: pct(textEdit.y, v.page.h),
    width: pct(textEdit.w, v.page.w),
    fontSize: textEdit.size * ed.pxPerPt + 'px',
    lineHeight: String(TEXT_LINE),
    fontFamily: TEXT_FONT,
    color: textEdit.color,
  });
  autoGrowText();
}

function autoGrowText() {
  const el = textEdit?.el;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function commitText() {
  if (!textEdit) return;
  const { v, x, y, w, item, el, size, color } = textEdit;
  textEdit = null;
  el.remove();
  const text = el.value.replace(/\s+$/, '');
  if (!ed || !ed.views.includes(v)) return;
  if (!text) {
    if (item) replaceStrokes(v, [item], [null]);
    else v.drawInk();
    return;
  }
  const h = textHeight(text, size, w);
  const next = { tool: 'text', text, color, width: size, pts: [round2(x), round2(y), 0.5, round2(x + w), round2(y + h), 0.5] };
  if (item) {
    if (item.text === next.text && item.color === next.color && item.width === next.width) return v.drawInk();
    replaceStrokes(v, [item], [next]);
  } else {
    const strokes = v.strokes;
    const before = strokes.slice();
    strokes.push(next);
    pushUndo({ type: 'snapshot', pageId: v.page.id, before, after: strokes.slice() });
    v.drawInk();
    markDirty(v.page.id);
  }
}

/* ---------------- Resim ekleme ---------------- */

const IMAGE_MAX_PX = 1600;

async function insertImage(file) {
  if (!ed) return;
  const hide = ui.busy('Resim ekleniyor…');
  try {
    const bmp = await createImageBitmap(file);
    // Büyük fotoğrafları küçült: notlarda yer kaplamasın, yedekler hafif kalsın.
    const scale = Math.min(1, IMAGE_MAX_PX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const png = file.type === 'image/png' && file.size < 600_000;
    const src = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85);
    const v = ed.views[currentIndex()];
    // Sayfanın görünen ortasına, sayfa genişliğinin en fazla %60'ı kadar yerleştir.
    const w = Math.min(v.page.w * 0.6, c.width);
    const h = (w * c.height) / c.width;
    const r = v.el.getBoundingClientRect();
    const view = pagesEl.getBoundingClientRect();
    const midY = ((view.top + view.height / 2 - r.top) / r.height) * v.page.h;
    const x = (v.page.w - w) / 2;
    const y = clamp(midY - h / 2, 16, Math.max(16, v.page.h - h - 16));
    addStrokes(v, [{ tool: 'image', src, color: '#000', width: 0, pts: [round2(x), round2(y), 0.5, round2(x + w), round2(y + h), 0.5] }]);
    updateToolbar();
    ui.toast('Resim eklendi. Sürükleyerek taşı, köşeden büyüt.');
  } catch (err) {
    console.error(err);
    ui.toast('Resim eklenemedi');
  } finally {
    hide();
  }
}

/* ---------------- Arama ---------------- */

let search = null; // { el, input, list }
const pageTextCache = new Map(); // pdf sayfa no → metin parçaları

function openSearch() {
  if (!ed || overview || search) return;
  const el = document.createElement('div');
  el.className = 'search-panel';
  el.innerHTML = `<header class="ov-head"><b>Ara</b>
      <input class="input search-input" type="search" placeholder="${ed.pdf ? 'PDF ve metin kutularında ara…' : 'Metin kutularında ara…'}" enterkeyhint="search">
      <button class="icon" id="search-close" title="Kapat">${icon('close')}</button></header>
    <div class="search-list"></div>`;
  $('editor').append(el);
  search = { el, input: el.querySelector('.search-input'), list: el.querySelector('.search-list') };
  history.pushState({ ...history.state, search: true }, '');
  el.querySelector('#search-close').onclick = () => history.back();
  let timer = 0;
  search.input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  });
  search.list.innerHTML = `<p class="search-empty">${
    ed.pdf ? 'PDF içindeki yazılarda ve eklediğin metin kutularında arar. El yazısı aranamaz.' : 'Eklediğin metin kutularında arar. El yazısı aranamaz.'
  }</p>`;
  setTimeout(() => search?.input.focus(), 50);
}

const norm = fold;

async function pageText(pdfPage) {
  if (!pageTextCache.has(pdfPage)) {
    const p = await ed.pdf.getPage(pdfPage);
    const vp = p.getViewport({ scale: 1 });
    const tc = await p.getTextContent();
    // Her parça için sayfadaki dikdörtgeni (pt) de sakla: sonucu vurgulamak için.
    const items = tc.items
      .filter((it) => it.str?.trim())
      .map((it) => {
        const t = pdfUtil.transform(vp.transform, it.transform);
        const h = Math.hypot(t[2], t[3]) || 10;
        return { str: it.str, x: t[4], y: t[5] - h, w: it.width * vp.scale, h: h * 1.15 };
      });
    pageTextCache.set(pdfPage, items);
  }
  return pageTextCache.get(pdfPage);
}

async function runSearch() {
  if (!search || !ed) return;
  const q = norm(search.input.value.trim());
  const list = search.list;
  if (q.length < 2) {
    list.innerHTML = '<p class="search-empty">En az 2 harf yaz.</p>';
    return;
  }
  list.innerHTML = '<p class="search-empty">Aranıyor…</p>';
  const results = [];
  const token = (search.token = {});
  for (let i = 0; i < ed.views.length; i++) {
    const page = ed.views[i].page;
    for (const s of ed.ink.get(page.id) || []) {
      if (s.tool === 'text' && norm(s.text).includes(q)) results.push({ i, snippet: s.text, rect: { x: s.pts[0], y: s.pts[1], w: s.pts[3] - s.pts[0], h: s.pts[4] - s.pts[1] } });
    }
    if (page.kind === 'pdf' && ed.pdf) {
      const items = await pageText(page.pdfPage);
      if (search?.token !== token) return; // bu arada yeni arama başladı
      for (const it of items) if (norm(it.str).includes(q)) results.push({ i, snippet: it.str, rect: it });
    }
    if (results.length >= 200) break;
  }
  if (search?.token !== token) return;
  if (!results.length) {
    list.innerHTML = '<p class="search-empty">Sonuç bulunamadı.</p>';
    return;
  }
  list.innerHTML = `<p class="search-count">${results.length >= 200 ? '200+' : results.length} sonuç</p>`;
  for (const r of results) {
    const b = document.createElement('button');
    b.className = 'search-hit-row';
    const text = r.snippet.length > 140 ? r.snippet.slice(0, 140) + '…' : r.snippet;
    const at = norm(text).indexOf(q);
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    b.innerHTML = `<span class="search-page">Sayfa ${r.i + 1}</span><span>${
      at >= 0 ? esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + q.length)) + '</mark>' + esc(text.slice(at + q.length)) : esc(text)
    }</span>`;
    b.onclick = () => {
      history.back();
      showHit(r);
    };
    list.append(b);
  }
}

function showHit(r) {
  const v = ed.views[r.i];
  document.querySelectorAll('.search-mark').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'search-mark';
  const pct = (val, total) => (val / total) * 100 + '%';
  Object.assign(m.style, {
    left: pct(r.rect.x - 2, v.page.w),
    top: pct(r.rect.y - 2, v.page.h),
    width: pct(r.rect.w + 4, v.page.w),
    height: pct(r.rect.h + 4, v.page.h),
  });
  v.el.append(m);
  // İşaretlenen yeri ekranın ortasına getir.
  const pageTop = v.el.offsetTop;
  pagesEl.scrollTop = pageTop + (r.rect.y / v.page.h) * v.el.offsetHeight - pagesEl.clientHeight / 2;
  updateIndicator();
  setTimeout(() => m.classList.add('fade'), 2500);
  setTimeout(() => m.remove(), 3500);
}

/* ---------------- Yer imleri ---------------- */

function updateBookmark(v) {
  v.el.classList.toggle('bookmarked', !!v.page.bookmark);
}

async function toggleBookmark(idx) {
  const v = ed.views[idx];
  v.page.bookmark = !v.page.bookmark;
  updateBookmark(v);
  ed.changed = true;
  await saveNotebook();
  refreshOverview();
  ui.toast(v.page.bookmark ? `Sayfa ${idx + 1} yer imlerine eklendi` : 'Yer imi kaldırıldı');
}

/* ---------------- PDF olarak dışa aktarma ---------------- */

async function exportPdf() {
  if (!ed) return;
  await flushSaves();
  const canShare = !!navigator.canShare;
  const choice = canShare
    ? await ui.actionSheet({ title: 'Dışa aktar', actions: [{ id: 'download', label: 'PDF olarak indir' }, { id: 'share', label: 'Paylaş…' }] })
    : 'download';
  if (!choice || !ed) return;
  const hide = ui.busy('PDF hazırlanıyor…');
  try {
    const bytes = await buildPdf();
    const name = (ed.nb.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'not') + '.pdf';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (choice === 'share') {
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        hide();
        try {
          await navigator.share({ files: [file], title: ed.nb.title });
          return;
        } catch (err) {
          if (err?.name === 'AbortError') return;
          // Hazırlık uzun sürdüyse tarayıcı paylaşıma izin vermeyebilir; o zaman indirmeye geç.
        }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    ui.toast('PDF "İndirilenler" klasörüne kaydedildi');
  } catch (err) {
    console.error(err);
    ui.toast('Dışa aktarılamadı: ' + (err?.message || err));
  } finally {
    hide();
  }
}

async function buildPdf() {
  const { PDFDocument, degrees } = window.PDFLib;
  const out = await PDFDocument.create();
  let src = null;
  if (ed.nb.fileId) {
    try {
      const f = await db.get('files', ed.nb.fileId);
      src = await PDFDocument.load(await f.blob.arrayBuffer(), { ignoreEncryption: true });
    } catch (err) {
      console.warn('Orijinal PDF kopyalanamadı, sayfalar görüntü olarak eklenecek', err);
    }
  }
  for (const page of ed.nb.pages) {
    let p = null;
    if (page.kind === 'pdf' && src) {
      try {
        [p] = await out.copyPages(src, [page.pdfPage - 1]);
        out.addPage(p);
      } catch {
        p = null;
      }
    }
    if (!p) {
      p = out.addPage([page.w, page.h]);
      if (hasTemplate(page)) drawTemplatePdf(p, page);
      if (page.kind === 'pdf' && ed.pdf) {
        const c = document.createElement('canvas');
        c.width = Math.round(page.w * 2);
        c.height = Math.round(page.h * 2);
        await renderPdfPage(ed.pdf, page, c);
        const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
        p.drawImage(img, { x: 0, y: 0, width: page.w, height: page.h });
        c.width = c.height = 0;
      }
    }
    const strokes = ed.ink.get(page.id);
    if (!strokes?.length) continue;
    await preloadImages(strokes);
    const layer = renderInkLayer(page, strokes, 2.5);
    const png = await out.embedPng(await canvasBytes(layer, 'image/png'));
    layer.width = layer.height = 0; // her sayfadan sonra belleği hemen bırak
    drawOverlay(p, png, page, degrees);
  }
  return out.save();
}

// Şablonu PDF'e vektör olarak çizer (PDF'te y ekseni aşağıdan yukarı doğru).
function drawTemplatePdf(p, page) {
  const { rgb } = window.PDFLib;
  const color = (hex) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
  const { lines, dots } = templateShapes(page);
  for (const [x1, y1, x2, y2, c, width] of lines) {
    p.drawLine({ start: { x: x1, y: page.h - y1 }, end: { x: x2, y: page.h - y2 }, thickness: width, color: color(c) });
  }
  for (const [x, y, r, c] of dots) p.drawCircle({ x, y: page.h - y, size: r, color: color(c) });
}

// Döndürülmüş PDF sayfalarında notların ekranda göründüğü yerde kalması için görüntüyü ters yönde döndür.
function drawOverlay(p, img, page, degrees) {
  const rot = ((p.getRotation().angle % 360) + 360) % 360;
  const b = p.getCropBox();
  const size = { width: page.w, height: page.h };
  if (rot === 90) p.drawImage(img, { x: b.x + b.width, y: b.y, ...size, rotate: degrees(90) });
  else if (rot === 180) p.drawImage(img, { x: b.x + b.width, y: b.y + b.height, ...size, rotate: degrees(180) });
  else if (rot === 270) p.drawImage(img, { x: b.x, y: b.y + b.height, ...size, rotate: degrees(270) });
  else p.drawImage(img, { x: b.x, y: b.y, ...size });
}
