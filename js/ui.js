import { collator, loadJSON, saveJSON } from './util.js';
import { TEMPLATES, drawTemplate } from './render.js';

const root = () => document.getElementById('modal-root');

function modal(build, extraClass = '') {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const box = document.createElement('div');
    box.className = 'modal ' + extraClass;
    backdrop.append(box);
    let finished = false;
    const close = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    build(box, close);
    root().append(backdrop);
  });
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function buttonRow(buttons) {
  const row = el('div', 'row');
  row.append(...buttons);
  return row;
}

export function promptModal({ title, value = '', placeholder = '', ok = 'Tamam' }) {
  return modal((box, close) => {
    const input = el('input', 'input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    const submit = () => {
      const v = input.value.trim();
      if (v) close(v);
      else input.focus();
    };
    const cancel = el('button', 'btn', 'Vazgeç');
    cancel.onclick = () => close(null);
    const okBtn = el('button', 'btn primary', ok);
    okBtn.onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    box.append(el('h3', '', title), input, buttonRow([cancel, okBtn]));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

export async function confirmModal({ title, message = '', ok = 'Sil', danger = true }) {
  const answer = await modal((box, close) => {
    const cancel = el('button', 'btn', 'Vazgeç');
    cancel.onclick = () => close(false);
    const okBtn = el('button', danger ? 'btn danger' : 'btn primary', ok);
    okBtn.onclick = () => close(true);
    box.append(el('h3', '', title));
    if (message) box.append(el('p', 'msg', message));
    box.append(buttonRow([cancel, okBtn]));
  });
  return answer === true;
}

export function actionSheet({ title, actions }) {
  return modal((box, close) => {
    if (title) box.append(el('h3', '', title));
    const list = el('div', 'action-list');
    for (const a of actions) {
      const b = el('button', 'action' + (a.danger ? ' danger' : ''), a.label);
      b.onclick = () => close(a.id);
      list.append(b);
    }
    box.append(list);
  }, 'sheet');
}

// Sayfa şablonu seçtirir; en son seçilen şablon hatırlanır.
// withPosition: "bu sayfadan sonra / önce" seçeneği de gösterilir. Dönüş: { template, position } ya da null.
export function templatePicker({ title, ok = 'Ekle', withPosition = false }) {
  const saved = loadJSON('nd-template', { template: 'blank', position: 'after' });
  return modal((box, close) => {
    let template = saved.template;
    let position = saved.position;
    const grid = el('div', 'tpl-grid');
    for (const t of TEMPLATES) {
      const b = el('button', 'tpl' + (t.id === template ? ' selected' : ''));
      const c = document.createElement('canvas');
      c.width = 150;
      c.height = 212;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      const k = c.width / 595.28;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawTemplate(ctx, { w: 595.28, h: 841.89, template: t.id });
      b.append(c, el('span', '', t.label));
      b.onclick = () => {
        template = t.id;
        grid.querySelectorAll('.tpl').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      };
      b.ondblclick = () => submit();
      grid.append(b);
    }
    box.append(el('h3', '', title), grid);
    if (withPosition) {
      const seg = el('div', 'segmented');
      for (const [id, label] of [['after', 'Bu sayfadan sonra'], ['before', 'Bu sayfadan önce']]) {
        const b = el('button', id === position ? 'on' : '', label);
        b.onclick = () => {
          position = id;
          seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        };
        seg.append(b);
      }
      box.append(seg);
    }
    const submit = () => {
      saveJSON('nd-template', { template, position });
      close({ template, position });
    };
    const cancel = el('button', 'btn', 'Vazgeç');
    cancel.onclick = () => close(null);
    const okBtn = el('button', 'btn primary', ok);
    okBtn.onclick = submit;
    box.append(buttonRow([cancel, okBtn]));
  }, 'wide');
}

// Açma-kapama düğmeli ayarlar listesi. items: [{ key, label, desc, value }], groups ile başlık eklenebilir.
// Her değişiklikte onChange(key, value) çağrılır; extra: listenin altına eklenecek düğmeler [{ label, onClick }].
export function settingsModal({ title, groups, onChange, extra = [] }) {
  return modal((box, close) => {
    box.append(el('h3', '', title));
    const list = el('div', 'settings-list');
    for (const g of groups) {
      if (g.title) list.append(el('div', 'settings-group', g.title));
      for (const it of g.items) {
        const row = el('label', 'setting');
        const text = el('span', 'setting-text');
        text.append(el('b', '', it.label));
        if (it.desc) text.append(el('small', '', it.desc));
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'switch';
        input.checked = !!it.value;
        input.onchange = () => onChange(it.key, input.checked);
        row.append(text, input);
        list.append(row);
      }
    }
    box.append(list);
    const buttons = extra.map((x) => {
      const b = el('button', 'btn', x.label);
      b.onclick = () => x.onClick(b);
      return b;
    });
    const done = el('button', 'btn primary', 'Tamam');
    done.onclick = () => close(true);
    box.append(buttonRow([...buttons, done]));
  }, 'wide settings');
}

export function colorPicker({ title, colors, selected }) {
  return modal((box, close) => {
    const grid = el('div', 'color-grid');
    for (const c of colors) {
      const b = el('button', 'color-choice' + (c === selected ? ' selected' : ''));
      b.style.setProperty('--c', c);
      b.setAttribute('aria-label', c);
      b.onclick = () => close(c);
      grid.append(b);
    }
    const cancel = el('button', 'btn', 'Vazgeç');
    cancel.onclick = () => close(null);
    box.append(el('h3', '', title), grid, buttonRow([cancel]));
  });
}

// Klasör ağacından hedef seçtirir. exclude: seçilemeyecek klasör id'leri (kendisi ve alt klasörleri).
export function folderPicker({ title, folders, exclude = new Set(), selected = 'root' }) {
  return modal((box, close) => {
    const children = new Map();
    for (const f of folders) {
      if (!children.has(f.parentId)) children.set(f.parentId, []);
      children.get(f.parentId).push(f);
    }
    let choice = selected;
    const list = el('div', 'folder-list');
    const addRow = (id, name, depth, color) => {
      const row = el('button', 'folder-row' + (id === choice ? ' selected' : ''), name);
      row.style.paddingLeft = 12 + depth * 22 + 'px';
      if (color) row.style.setProperty('--fc', color);
      row.onclick = () => {
        choice = id;
        list.querySelectorAll('.folder-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
      };
      list.append(row);
    };
    const walk = (parentId, depth) => {
      const kids = (children.get(parentId) || []).sort((a, b) => collator.compare(a.name, b.name));
      for (const f of kids) {
        if (exclude.has(f.id)) continue;
        addRow(f.id, f.name, depth, f.color || '#3b82f6');
        walk(f.id, depth + 1);
      }
    };
    addRow('root', 'Kitaplık (ana klasör)', 0);
    walk('root', 1);
    const cancel = el('button', 'btn', 'Vazgeç');
    cancel.onclick = () => close(null);
    const okBtn = el('button', 'btn primary', 'Buraya taşı');
    okBtn.onclick = () => close(choice);
    box.append(el('h3', '', title), list, buttonRow([cancel, okBtn]));
  });
}

let toastEl = null;
let toastTimer = 0;
export function toast(message) {
  if (!toastEl) {
    toastEl = el('div', 'toast');
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

export function busy(message) {
  const b = el('div', 'backdrop busy');
  const box = el('div', 'busy-box');
  box.append(el('div', 'spinner'), el('span', '', message));
  b.append(box);
  document.body.append(b);
  return () => b.remove();
}
