import * as db from './db.js';
import * as ui from './ui.js';
import { icon } from './icons.js';
import { openPdf } from './pdf.js';
import { drawStroke, drawStrokes, hitStroke, renderPdfPage, renderThumb, renderInkLayer, canvasBytes } from './render.js';
import { uid, loadJSON, saveJSON, round2, clamp } from './util.js';

const PEN_COLORS = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7c3aed'];
const HL_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa', '#fb923c'];
const PEN_WIDTHS = [0.9, 1.6, 2.8]; // PDF noktası
const HL_WIDTHS = [8, 14, 22];
const ERASER_RADIUS_PX = 10;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
const MAX_CANVAS_AREA = 12_000_000; // tablet belleğini korumak için sayfa başına üst sınır
const PALM_GUARD_MS = 600; // kalem yakındayken parmak/avuç dokunuşları yok sayılır
const A4 = { w: 595.28, h: 841.89 };

const settings = loadJSON('nd-tools', { tool: 'pen', penColor: 0, hlColor: 0, penWidth: 1, hlWidth: 1, fingerDraw: false });
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
    ed = { nb, pdf, ink, views: [], zoom: 1, pxPerPt: 1, undo: [], redo: [], dirty: new Set(), changed: false, saveTimer: 0, renderTimer: 0, io: null, topBar: null };
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
  active = null;
  touches.clear();
  stopInertia();
  await flushSaves();
  e.nb.lastPage = currentIndex();
  if (e.changed) {
    e.nb.updatedAt = Date.now();
    try {
      e.nb.thumb = await renderThumb(e.pdf, e.nb.pages[0], e.ink.get(e.nb.pages[0].id));
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
    if (page.kind === 'pdf') {
      this.bg = document.createElement('canvas');
      this.bg.className = 'bg';
      this.el.append(this.bg);
    }
    this.ink = document.createElement('canvas');
    this.ink.className = 'ink';
    this.el.append(this.ink);

    this.bar = document.createElement('div');
    this.bar.className = 'pbar';
    this.bar.innerHTML = `<span class="plabel"></span>
      <button class="padd">${icon('plus')}<span>Araya boş sayfa ekle</span></button>
      <button class="pdel" title="Bu sayfayı sil">${icon('trash')}</button>`;
    this.label = this.bar.querySelector('.plabel');
    this.bar.querySelector('.padd').onclick = () => insertBlank(ed.views.indexOf(this) + 1);
    this.bar.querySelector('.pdel').onclick = () => deletePage(this);
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
    if (this.page.kind !== 'pdf' || !ed.pdf) return;
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

  drawInk() {
    if (!this.ink.width) return;
    const ctx = this.ink.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    drawStrokes(this.inkContext(), this.strokes);
  }

  addStroke(s) {
    if (this.ink.width) drawStroke(this.inkContext(), s);
  }
}

function buildPages() {
  sheetEl.innerHTML = '';
  ed.io = new IntersectionObserver(onIntersect, { root: pagesEl, rootMargin: '100% 50%' });
  ed.topBar = document.createElement('div');
  ed.topBar.className = 'pbar top';
  ed.topBar.innerHTML = `<button class="padd">${icon('plus')}<span>Başa boş sayfa ekle</span></button>`;
  ed.topBar.querySelector('.padd').onclick = () => insertBlank(0);
  sheetEl.append(ed.topBar);
  for (const page of ed.nb.pages) {
    const v = new PageView(page);
    ed.views.push(v);
    sheetEl.append(v.el, v.bar);
  }
  layout();
  updateLabels();
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
    v.bar.style.width = w + 'px';
    widest = Math.max(widest, w);
  }
  ed.topBar.style.width = (ed.views[0]?.page.w ?? maxW) * ed.pxPerPt + 'px';
  sheetEl.style.width = Math.max(cw, widest + 32) + 'px';
}

function updateLabels() {
  const n = ed.views.length;
  ed.views.forEach((v, i) => {
    v.label.textContent = `Sayfa ${i + 1} / ${n}`;
  });
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

async function insertBlank(index) {
  if (!ed) return;
  const ref = ed.nb.pages[index - 1] || ed.nb.pages[index] || A4;
  const page = { id: uid(), kind: 'blank', w: ref.w, h: ref.h };
  ed.nb.pages.splice(index, 0, page);
  ed.ink.set(page.id, []);
  const v = new PageView(page);
  const anchor = index === 0 ? ed.topBar : ed.views[index - 1].bar;
  anchor.after(v.el, v.bar);
  ed.views.splice(index, 0, v);
  layout();
  updateLabels();
  ed.io.observe(v.el);
  ed.changed = true;
  await saveNotebook();
  pagesEl.scrollTop = v.el.offsetTop - 12;
  updateIndicator();
  ui.toast(`Boş sayfa eklendi (sayfa ${index + 1})`);
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
  const id = v.page.id;
  ed.io.unobserve(v.el);
  v.release();
  v.el.remove();
  v.bar.remove();
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
  updateLabels();
  updateToolbar();
  updateIndicator();
  ui.toast('Sayfa silindi');
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
    <button class="icon tool" data-tool="eraser" title="Silgi (dokunduğun çizgiyi siler)">${icon('eraser')}</button>
    <span class="sep"></span>
    <div class="group" id="tb-colors"></div>
    <div class="group" id="tb-widths"></div>
    <span class="sep"></span>
    <button class="icon" id="tb-undo" title="Geri al">${icon('undo')}</button>
    <button class="icon" id="tb-redo" title="Yinele">${icon('redo')}</button>
    <span class="sep"></span>
    <button class="icon" id="tb-zoom-out" title="Uzaklaştır">${icon('zoomOut')}</button>
    <button class="icon" id="tb-zoom-in" title="Yakınlaştır">${icon('zoomIn')}</button>
    <span class="spacer"></span>
    <button class="icon" id="tb-add-page" title="Bu sayfadan sonra boş sayfa ekle">${icon('filePlus')}</button>
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
      settings.tool = b.dataset.tool;
      saveSettings();
      updateToolbar();
    };
  });
  $('tb-undo').onclick = undo;
  $('tb-redo').onclick = redo;
  $('tb-zoom-in').onclick = () => zoomBy(1.25);
  $('tb-zoom-out').onclick = () => zoomBy(0.8);
  $('tb-add-page').onclick = () => insertBlank(currentIndex() + 1);
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
  colors.hidden = widths.hidden = tool === 'eraser';
  if (tool !== 'eraser') {
    const isHl = tool === 'hl';
    const palette = isHl ? HL_COLORS : PEN_COLORS;
    const colorKey = isHl ? 'hlColor' : 'penColor';
    const widthKey = isHl ? 'hlWidth' : 'penWidth';
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
    const dots = isHl ? [6, 10, 15] : [4, 7, 11];
    dots.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'wbtn' + (settings[widthKey] === i ? ' active' : '');
      b.title = ['İnce', 'Orta', 'Kalın'][i];
      b.innerHTML = `<span style="width:${d}px;height:${d}px;background:${palette[settings[colorKey]]}"></span>`;
      b.onclick = () => {
        settings[widthKey] = i;
        saveSettings();
        updateToolbar();
      };
      widths.append(b);
    });
  }
  $('tb-finger').classList.toggle('active', settings.fingerDraw);
  $('tb-undo').disabled = !ed?.undo.length;
  $('tb-redo').disabled = !ed?.redo.length;
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
  }
  viewById(op.pageId)?.drawInk();
  markDirty(op.pageId);
}

function undo() {
  const op = ed?.undo.pop();
  if (!op) return;
  applyOp(op, true);
  ed.redo.push(op);
  updateToolbar();
}

function redo() {
  const op = ed?.redo.pop();
  if (!op) return;
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
  if (e.pointerType === 'touch' && !settings.fingerDraw) {
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
  stopInertia();
  capture(e.pointerId);
  const v = pageEl._view;
  const rect = pageEl.getBoundingClientRect();
  const penButton = e.pointerType === 'pen' && (e.button === 5 || e.button === 2 || (e.buttons & 32) || (e.buttons & 2));
  const eraser = settings.tool === 'eraser' || !!penButton;
  active = { id: e.pointerId, v, rect, k: v.page.w / rect.width, eraser, erased: [], stroke: null, cursor: null };
  attachLive(v);
  if (eraser) {
    eraseAt(e);
  } else {
    const hl = settings.tool === 'hl';
    active.stroke = {
      tool: hl ? 'hl' : 'pen',
      color: hl ? HL_COLORS[settings.hlColor] : PEN_COLORS[settings.penColor],
      width: hl ? HL_WIDTHS[settings.hlWidth] : PEN_WIDTHS[settings.penWidth],
      pts: [],
    };
    addPoint(e, true);
  }
  requestLive();
}

function onMove(e) {
  if (e.pointerType === 'pen') lastPen = performance.now();
  if (active && e.pointerId === active.id) {
    const coalesced = e.getCoalescedEvents?.() || [];
    for (const ev of coalesced.length ? coalesced : [e]) {
      if (active.eraser) eraseAt(ev);
      else addPoint(ev, false);
    }
    requestLive();
    return;
  }
  if (touches.has(e.pointerId)) moveTouch(e);
}

function onUp(e) {
  if (active && e.pointerId === active.id) {
    finishStroke();
    return;
  }
  if (touches.has(e.pointerId)) endTouch(e);
}

function addPoint(ev, force) {
  const a = active;
  const x = (ev.clientX - a.rect.left) * a.k;
  const y = (ev.clientY - a.rect.top) * a.k;
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

function eraseAt(ev) {
  const a = active;
  const x = (ev.clientX - a.rect.left) * a.k;
  const y = (ev.clientY - a.rect.top) * a.k;
  a.cursor = { x, y };
  const strokes = a.v.strokes;
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (hitStroke(strokes[i], x, y, ERASER_RADIUS_PX * a.k)) {
      a.erased.push({ stroke: strokes[i], index: i });
      strokes.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    a.v.drawInk();
    markDirty(a.v.page.id);
  }
}

function finishStroke() {
  const a = active;
  active = null;
  liveCanvas.remove();
  const pageId = a.v.page.id;
  if (a.stroke?.pts.length) {
    a.v.strokes.push(a.stroke);
    a.v.addStroke(a.stroke);
    pushUndo({ type: 'add', pageId, stroke: a.stroke });
    markDirty(pageId);
  } else if (a.erased.length) {
    pushUndo({ type: 'erase', pageId, items: a.erased });
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
  if (active.stroke) drawStroke(ctx, active.stroke);
  if (active.eraser && active.cursor) {
    ctx.beginPath();
    ctx.arc(active.cursor.x, active.cursor.y, ERASER_RADIUS_PX * active.k, 0, Math.PI * 2);
    ctx.lineWidth = active.k;
    ctx.strokeStyle = 'rgba(100,116,139,.9)';
    ctx.fillStyle = 'rgba(148,163,184,.15)';
    ctx.fill();
    ctx.stroke();
  }
}

// Parmak hareketleri tarayıcıya bırakılmıyor (touch-action: none), çünkü kalemle yazarken sayfanın
// kaymaması gerekiyor. Bu yüzden kaydırma, iki parmakla yakınlaştırma ve kayma ataleti burada yapılıyor.
function startTouch(e) {
  capture(e.pointerId);
  stopInertia();
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
