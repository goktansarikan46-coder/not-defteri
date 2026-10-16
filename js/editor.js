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
} from './render.js';
import { recognizeShape } from './shapes.js';
import { uid, loadJSON, saveJSON, round2, clamp } from './util.js';

const PEN_COLORS = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7c3aed'];
const HL_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa', '#fb923c'];
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
const MAX_CANVAS_AREA = 12_000_000; // tablet belleğini korumak için sayfa başına üst sınır
const PALM_GUARD_MS = 450; // kalem yakındayken parmak/avuç dokunuşları yok sayılır
const A4 = { w: 595.28, h: 841.89 };

const settings = loadJSON('nd-tools', { tool: 'pen', penColor: 0, hlColor: 0, penWidth: 1, hlWidth: 1, fingerDraw: false });
// Eski sürümde kalınlık 3 seçenekten birinin sırasıydı; o seçimi gerçek kalınlığa çevir.
settings.penSize ??= OLD_PEN_WIDTHS[settings.penWidth] ?? 1.6;
settings.hlSize ??= OLD_HL_WIDTHS[settings.hlWidth] ?? 14;
settings.eraserMode ??= 'stroke'; // 'stroke': dokunulan çizginin tamamı, 'partial': yalnızca üzerinden geçilen kısım
settings.eraserSize ??= 1;
settings.favorites ??= [];
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
  buildToolbar();
  bindInput();
  window.addEventListener('resize', () => {
    if (!ed) return;
    layout();
    scheduleRerender();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaves();
  });
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
  clearSelection();
  closeOverlays();
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
    const seq = ++this.seq;
    this.ink.width = w;
    this.ink.height = h;
    this.drawInk();
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
    // Önce görünmeyen bir tuvale çiz, bitince değiştir: yakınlaştırırken titreme olmasın.
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    try {
      const pp = await ed.pdf.getPage(this.page.pdfPage);
      if (seq !== this.seq) return;
      this.task?.cancel();
      this.task = pp.render({ canvasContext: tmp.getContext('2d'), viewport: pp.getViewport({ scale: w / this.page.w }) });
      await this.task.promise;
      if (seq !== this.seq) return;
      this.bg.width = w;
      this.bg.height = h;
      this.bg.getContext('2d').drawImage(tmp, 0, 0);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error(err);
    } finally {
      tmp.width = tmp.height = 0;
    }
  }

  release() {
    this.seq++;
    this.task?.cancel();
    this.task = null;
    this.resKey = null;
    if (this.bg) this.bg.width = this.bg.height = 0;
    this.ink.width = this.ink.height = 0;
  }

  inkContext() {
    const ctx = this.ink.getContext('2d');
    const k = this.ink.width / this.page.w;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return ctx;
  }

  // exclude: o an taşınan (canlı katmanda çizilen) çizgiler
  drawInk(exclude) {
    if (!this.ink.width) return;
    const ctx = this.ink.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    drawStrokes(this.inkContext(), exclude ? this.strokes.filter((s) => !exclude.has(s)) : this.strokes);
  }

  addStroke(s) {
    if (this.ink.width) drawStroke(this.inkContext(), s);
  }
}

function buildPages() {
  sheetEl.innerHTML = '';
  ed.io = new IntersectionObserver(onIntersect, { root: pagesEl, rootMargin: '100% 50%' });
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
}

function scheduleRerender() {
  clearTimeout(ed.renderTimer);
  ed.renderTimer = setTimeout(() => {
    if (!ed) return;
    for (const v of ed.views) if (v.visible) v.render();
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
      { id: 'overview', label: 'Tüm sayfalar' },
      { id: 'delete', label: 'Bu sayfayı sil', danger: true },
    ],
  });
  if (!ed) return;
  if (action === 'paste') pasteClipboard(idx);
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
  else sheetEl.append(v.el);
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
  el.innerHTML = `<header class="ov-head"><b>Tüm sayfalar</b><span class="ov-hint">Dokun: sayfaya git · Tutamaktan sürükle: sırayı değiştir</span>
    <button class="icon" id="ov-close" title="Kapat">${icon('close')}</button></header><div class="ov-grid"></div>`;
  $('editor').append(el);
  const grid = el.querySelector('.ov-grid');
  overview = { el, grid, io: new IntersectionObserver(onThumbVisible, { root: grid, rootMargin: '300px' }), thumbs: new Map() };
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
  ed.views.forEach((v, i) => {
    const tile = document.createElement('div');
    tile.className = 'ov-tile' + (i === cur ? ' current' : '');
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
      { id: 'delete', label: 'Sil', danger: true },
    ],
  });
  if (!ed) return;
  if (action === 'duplicate') duplicatePage(idx);
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
  ed.saveTimer = setTimeout(flushSaves, 700);
}

async function flushSaves() {
  if (!ed) return;
  clearTimeout(ed.saveTimer);
  const { nb, ink } = ed;
  const ids = [...ed.dirty];
  ed.dirty.clear();
  try {
    for (const pageId of ids) {
      if (ink.has(pageId)) await db.put('ink', { pageId, notebookId: nb.id, strokes: ink.get(pageId) });
    }
  } catch (err) {
    console.error(err);
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
    <button class="icon tool" data-tool="pen" title="Kalem">${icon('pen')}</button>
    <button class="icon tool" data-tool="hl" title="Fosforlu kalem">${icon('highlighter')}</button>
    <button class="icon tool" data-tool="eraser" title="Silgi">${icon('eraser')}</button>
    <button class="icon tool" data-tool="lasso" title="Kement: çevresini çizerek seç, taşı, büyüt, sil">${icon('lasso')}</button>
    <span class="sep"></span>
    <div class="group" id="tb-colors"></div>
    <div class="group" id="tb-widths"></div>
    <button class="icon" id="tb-fav" title="Favori kalemler">${icon('star')}</button>
    <span class="lasso-hint" id="tb-lasso-hint">Seçmek istediğin yazının çevresini çiz</span>
    <span class="sep"></span>
    <button class="icon" id="tb-undo" title="Geri al">${icon('undo')}</button>
    <button class="icon" id="tb-redo" title="Yinele">${icon('redo')}</button>
    <span class="sep"></span>
    <button class="icon" id="tb-zoom-out" title="Uzaklaştır">${icon('zoomOut')}</button>
    <button class="icon" id="tb-zoom-in" title="Yakınlaştır">${icon('zoomIn')}</button>
    <span class="spacer"></span>
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
      if (settings.tool !== b.dataset.tool) clearSelection();
      settings.tool = b.dataset.tool;
      saveSettings();
      updateToolbar();
    };
  });
  $('tb-fav').onclick = () => (favPop ? closeFavPop() : openFavPop($('tb-fav')));
  $('tb-undo').onclick = undo;
  $('tb-redo').onclick = redo;
  $('tb-zoom-in').onclick = () => zoomBy(1.25);
  $('tb-zoom-out').onclick = () => zoomBy(0.8);
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
  $('tb-fav').hidden = tool === 'eraser' || tool === 'lasso';
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
    const b = document.createElement('button');
    b.className = 'size-btn' + (sizePop ? ' active' : '');
    b.id = 'tb-size';
    b.title = 'Kalınlık';
    b.innerHTML = sizeDot(tool, sizeOf(tool), palette[settings[colorKey]]) + `<span class="size-val">${fmtSize(sizeOf(tool))}</span>`;
    b.onclick = () => (sizePop ? closeSizePop() : openSizePop(b));
    widths.append(b);
  }
  if (favPop && (tool === 'eraser' || tool === 'lasso')) closeFavPop();
  if (sizePop && (tool === 'eraser' || tool === 'lasso' || sizePop.dataset.tool !== tool)) closeSizePop();
  else renderSizePop(); // renk değiştiyse önizleme de güncellensin
  $('tb-finger').classList.toggle('active', settings.fingerDraw);
  $('tb-undo').disabled = !ed?.undo.length;
  $('tb-redo').disabled = !ed?.redo.length;
}

/* ---------------- Kalınlık paneli ---------------- */

let sizePop = null;
const sizeOf = (tool) => (tool === 'hl' ? settings.hlSize : settings.penSize);
const fmtSize = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');
const currentColor = (tool) => (tool === 'hl' ? HL_COLORS[settings.hlColor] : PEN_COLORS[settings.penColor]);

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
  updateToolbar();
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
  updateToolbar();
}

function redo() {
  const op = ed?.redo.pop();
  if (!op) return;
  clearSelection();
  applyOp(op, false);
  ed.undo.push(op);
  updateToolbar();
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
  const penButton = e.pointerType === 'pen' && (e.button === 5 || e.button === 2 || (e.buttons & 32) || (e.buttons & 2));
  const base = { id: e.pointerId, v, rect, k: v.page.w / rect.width, cursor: null };
  const at = pagePoint(e, base);

  if (onSelection && selection.v === v) {
    startSelectionDrag(e, base, at, e.target.closest('.sel-handle') ? 'resize' : 'move');
    return;
  }
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
  let p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
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
  if (!a || a.kind !== 'ink' || a.snapped) return;
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
  navigator.vibrate?.(12);
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
  if (changed) {
    a.changed = true;
    a.v.drawInk();
    markDirty(a.v.page.id);
  }
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
  liveCanvas.remove();
  const pageId = a.v.page.id;
  if (a.kind === 'ink' && a.stroke.pts.length) {
    a.v.strokes.push(a.stroke);
    a.v.addStroke(a.stroke);
    pushUndo({ type: 'add', pageId, stroke: a.stroke });
    markDirty(pageId);
  } else if (a.kind === 'erase' && a.changed) {
    if (settings.eraserMode === 'partial') pushUndo({ type: 'snapshot', pageId, before: a.before, after: a.v.strokes.slice() });
    else pushUndo({ type: 'erase', pageId, items: a.erased });
  } else if (a.kind === 'lasso') {
    finishLasso(a);
  } else if (a.kind === 'move' || a.kind === 'resize') {
    finishSelectionDrag(a);
  }
}

function attachLive(v) {
  const w = v.ink.width || Math.round(v.el.clientWidth * (window.devicePixelRatio || 1));
  const h = v.ink.height || Math.round(v.el.clientHeight * (window.devicePixelRatio || 1));
  if (liveCanvas.width !== w || liveCanvas.height !== h) {
    liveCanvas.width = w;
    liveCanvas.height = h;
  }
  liveCanvas.getContext('2d').clearRect(0, 0, w, h);
  v.el.append(liveCanvas);
}

function requestLive() {
  if (!liveRaf) liveRaf = requestAnimationFrame(drawLive);
}

function drawLive() {
  liveRaf = 0;
  if (!active) return;
  const ctx = liveCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  const k = liveCanvas.width / active.v.page.w;
  ctx.setTransform(k, 0, 0, k, 0, 0);
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
    for (const c of [...PEN_COLORS, ...HL_COLORS]) {
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

/* ---------------- Favori kalemler ---------------- */

let favPop = null;

const favKey = (f) => `${f.tool}|${f.color}|${f.size}`;

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
  const cur = { tool: settings.tool, color: settings.tool === 'hl' ? settings.hlColor : settings.penColor, size: sizeOf(settings.tool) };
  const favs = settings.favorites;
  favPop.innerHTML = `<div class="size-head"><b>Favori kalemler</b></div><div class="fav-list"></div>
    <button class="btn fav-add">${icon('plus')}<span>Şu anki kalemi ekle</span></button>`;
  const list = favPop.querySelector('.fav-list');
  if (!favs.length) list.innerHTML = '<p class="fav-empty">Sık kullandığın renk ve kalınlığı buraya ekle, tek dokunuşla geç.</p>';
  favs.forEach((f, i) => {
    const color = (f.tool === 'hl' ? HL_COLORS : PEN_COLORS)[f.color];
    const name = f.tool === 'hl' ? 'Fosforlu' : 'Kalem';
    const item = document.createElement('div');
    item.className = 'fav' + (favKey(f) === favKey(cur) ? ' active' : '');
    item.innerHTML = `<button class="fav-use">${sizeDot(f.tool, f.size, color)}<span>${name} · ${fmtSize(f.size)}</span></button>
      <button class="fav-del" title="Favorilerden çıkar">${icon('close')}</button>`;
    item.querySelector('.fav-use').onclick = () => {
      settings.tool = f.tool;
      if (f.tool === 'hl') {
        settings.hlColor = f.color;
        settings.hlSize = f.size;
      } else {
        settings.penColor = f.color;
        settings.penSize = f.size;
      }
      saveSettings();
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
    if (!t.moved && t.max >= 2 && performance.now() - t.start <= TAP_MAX_MS) {
      pinch = null;
      if (t.max === 2) {
        if (ed.undo.length) {
          undo();
          ui.toast('Geri alındı');
        }
      } else if (ed.redo.length) {
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
  const t = performance.now();
  const recent = velSamples.filter((s) => t - s.t < 100);
  if (recent.length < 2) return;
  const dt = Math.max(16, t - recent[0].t);
  startInertia(recent.reduce((s, r) => s + r.dx, 0) / dt, recent.reduce((s, r) => s + r.dy, 0) / dt);
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
      }
    }
    const strokes = ed.ink.get(page.id);
    if (!strokes?.length) continue;
    const png = await out.embedPng(await canvasBytes(renderInkLayer(page, strokes, 3), 'image/png'));
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
