import * as db from './db.js';
import * as ui from './ui.js';
import { icon } from './icons.js';
import { openPdf, pageSizes, isPasswordError } from './pdf.js';
import { renderThumb } from './render.js';
import { createBackup, readBackup, restoreBackup, lastBackupTime, markBackedUp } from './backup.js';
import { uid, collator, formatDate, escapeHtml, loadJSON, saveJSON, round2 } from './util.js';

const A4 = { w: 595.28, h: 841.89 };
const $ = (id) => document.getElementById(id);

let current = loadJSON('nd-library', { folder: 'root' }).folder;
let openNotebook = () => {};

function setCurrent(id) {
  current = id;
  saveJSON('nd-library', { folder: id });
}

export function initLibrary({ onOpenNotebook }) {
  openNotebook = onOpenNotebook;
  $('btn-backup').innerHTML = icon('archive') + '<span>Yedek</span>';
  $('btn-backup').addEventListener('click', backupMenu);
  $('backup-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await restoreFrom(file);
  });
  $('btn-new-folder').innerHTML = icon('folderPlus') + '<span>Yeni klasör</span>';
  $('btn-new-notebook').innerHTML = icon('filePlus') + '<span>Boş defter</span>';
  $('btn-import').innerHTML = icon('upload') + '<span>PDF aç</span>';
  $('btn-new-folder').addEventListener('click', newFolder);
  $('btn-new-notebook').addEventListener('click', newBlankNotebook);
  $('btn-import').addEventListener('click', () => $('pdf-input').click());
  $('pdf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const nb = await importPdf(file, file.name);
    if (nb) openNotebook(nb.id);
  });
}

export async function renderLibrary() {
  const [folders, notebooks] = await Promise.all([db.getAll('folders'), db.getAll('notebooks')]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  if (current !== 'root' && !byId.has(current)) setCurrent('root');

  const path = [];
  for (let f = byId.get(current); f; f = byId.get(f.parentId)) path.unshift(f);
  const crumbs = $('crumbs');
  crumbs.innerHTML = '';
  crumbs.append(crumb('Kitaplık', 'root', path.length === 0));
  path.forEach((f, i) => {
    crumbs.append(Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '›' }));
    crumbs.append(crumb(f.name, f.id, i === path.length - 1));
  });

  const subFolders = folders.filter((f) => f.parentId === current).sort((a, b) => collator.compare(a.name, b.name));
  const nbs = notebooks.filter((n) => n.folderId === current).sort((a, b) => b.updatedAt - a.updatedAt);
  renderBackupHint(notebooks.length);
  const grid = $('lib-grid');
  grid.innerHTML = '';
  if (!subFolders.length && !nbs.length) {
    grid.innerHTML = `<div class="empty">${icon('folder')}<p><b>${current === 'root' ? 'Kitaplığın boş' : 'Bu klasör boş'}</b></p>
      <p>Sağ üstten <b>PDF aç</b> ile bir PDF ekle, <b>Boş defter</b> oluştur ya da notlarını ayırmak için <b>Yeni klasör</b> aç.</p></div>`;
    return;
  }
  for (const f of subFolders) {
    const count = folders.filter((x) => x.parentId === f.id).length + notebooks.filter((n) => n.folderId === f.id).length;
    grid.append(folderCard(f, count, folders, notebooks));
  }
  for (const nb of nbs) grid.append(notebookCard(nb, folders));
}

function crumb(label, id, isCurrent) {
  const b = document.createElement('button');
  b.className = 'crumb' + (isCurrent ? ' current' : '');
  b.textContent = label;
  b.onclick = () => {
    setCurrent(id);
    renderLibrary();
  };
  return b;
}

function card(className, thumbHtml, name, sub) {
  const el = document.createElement('div');
  el.className = 'card ' + className;
  el.innerHTML = `<div class="thumb">${thumbHtml}</div>
    <div class="meta"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub)}</div></div>
    <button class="more" aria-label="Seçenekler">${icon('more')}</button>`;
  return el;
}

function folderCard(f, count, folders, notebooks) {
  const el = card('folder', icon('folder'), f.name, count ? `${count} öğe` : 'Boş');
  el.addEventListener('click', (e) => {
    if (e.target.closest('.more')) return;
    setCurrent(f.id);
    renderLibrary();
  });
  el.querySelector('.more').addEventListener('click', async () => {
    const action = await ui.actionSheet({
      title: f.name,
      actions: [
        { id: 'rename', label: 'Yeniden adlandır' },
        { id: 'move', label: 'Taşı' },
        { id: 'delete', label: 'Klasörü sil', danger: true },
      ],
    });
    if (action === 'rename') {
      const name = await ui.promptModal({ title: 'Klasörü yeniden adlandır', value: f.name, ok: 'Kaydet' });
      if (name) await db.put('folders', { ...f, name });
    } else if (action === 'move') {
      const exclude = descendants(f.id, folders);
      const target = await ui.folderPicker({ title: `"${f.name}" nereye taşınsın?`, folders, exclude, selected: f.parentId });
      if (target && target !== f.parentId) await db.put('folders', { ...f, parentId: target });
    } else if (action === 'delete') {
      const ids = descendants(f.id, folders);
      const inside = notebooks.filter((n) => ids.has(n.folderId));
      const ok = await ui.confirmModal({
        title: `"${f.name}" silinsin mi?`,
        message: inside.length
          ? `İçindeki ${inside.length} defter ve tüm alt klasörler de kalıcı olarak silinecek.`
          : 'Klasör ve alt klasörleri silinecek.',
      });
      if (!ok) return;
      for (const nb of inside) await db.deleteNotebook(nb);
      for (const id of ids) await db.del('folders', id);
      ui.toast('Klasör silindi');
    }
    renderLibrary();
  });
  return el;
}

function notebookCard(nb, folders) {
  const thumb = nb.thumb ? `<img src="${nb.thumb}" alt="">` : icon('file');
  const el = card('notebook', thumb, nb.title, `${nb.pages.length} sayfa · ${formatDate(nb.updatedAt)}`);
  el.addEventListener('click', (e) => {
    if (e.target.closest('.more')) return;
    openNotebook(nb.id);
  });
  el.querySelector('.more').addEventListener('click', async () => {
    const action = await ui.actionSheet({
      title: nb.title,
      actions: [
        { id: 'rename', label: 'Yeniden adlandır' },
        { id: 'move', label: 'Başka klasöre taşı' },
        { id: 'delete', label: 'Defteri sil', danger: true },
      ],
    });
    if (action === 'rename') {
      const title = await ui.promptModal({ title: 'Defteri yeniden adlandır', value: nb.title, ok: 'Kaydet' });
      if (title) await db.put('notebooks', { ...nb, title });
    } else if (action === 'move') {
      const target = await ui.folderPicker({ title: `"${nb.title}" nereye taşınsın?`, folders, selected: nb.folderId });
      if (target && target !== nb.folderId) {
        await db.put('notebooks', { ...nb, folderId: target });
        ui.toast('Defter taşındı');
      }
    } else if (action === 'delete') {
      const ok = await ui.confirmModal({
        title: `"${nb.title}" silinsin mi?`,
        message: 'Defter, PDF ve üzerindeki tüm notlar kalıcı olarak silinecek.',
      });
      if (!ok) return;
      await db.deleteNotebook(nb);
      ui.toast('Defter silindi');
    }
    renderLibrary();
  });
  return el;
}

function descendants(rootId, folders) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (!ids.has(f.id) && ids.has(f.parentId)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

async function newFolder() {
  const name = await ui.promptModal({ title: 'Yeni klasör', placeholder: 'Klasör adı (ör. Matematik)', ok: 'Oluştur' });
  if (!name) return;
  await db.put('folders', { id: uid(), parentId: current, name, createdAt: Date.now() });
  renderLibrary();
}

async function newBlankNotebook() {
  const title = await ui.promptModal({ title: 'Yeni boş defter', value: 'Yeni defter', ok: 'Oluştur' });
  if (!title) return;
  const now = Date.now();
  const page = { id: uid(), kind: 'blank', w: A4.w, h: A4.h };
  const nb = { id: uid(), folderId: current, title, fileId: null, pages: [page], createdAt: now, updatedAt: now, lastPage: 0 };
  nb.thumb = await renderThumb(null, page, []);
  await db.put('notebooks', nb);
  openNotebook(nb.id);
}

/* ---------------- Yedekleme ---------------- */

const BACKUP_REMIND_DAYS = 7;

function backupAgeText() {
  const at = lastBackupTime();
  if (!at) return 'Henüz hiç yedek almadın.';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days === 0 ? 'Son yedek: bugün.' : `Son yedek: ${days} gün önce (${formatDate(at)}).`;
}

function renderBackupHint(notebookCount) {
  const hint = $('backup-hint');
  const at = lastBackupTime();
  const stale = notebookCount > 0 && Date.now() - at > BACKUP_REMIND_DAYS * 86_400_000;
  hint.classList.toggle('hidden', !stale);
  if (!stale) return;
  hint.innerHTML = `<span>${icon('archive')}${escapeHtml(backupAgeText())} Notların sadece bu tablette duruyor.</span>
    <button class="btn">Şimdi yedek al</button>`;
  hint.querySelector('button').onclick = () => backupMenu();
}

async function backupMenu() {
  const canShare = !!navigator.canShare;
  const action = await ui.actionSheet({
    title: 'Yedekleme · ' + backupAgeText(),
    actions: [
      { id: 'download', label: 'Yedek al ve indir' },
      ...(canShare ? [{ id: 'share', label: 'Yedek al ve paylaş (Drive, e-posta…)' }] : []),
      { id: 'restore', label: 'Yedekten geri yükle' },
    ],
  });
  if (action === 'restore') $('backup-input').click();
  else if (action) await makeBackup(action === 'share');
}

async function makeBackup(share) {
  const hide = ui.busy('Yedek hazırlanıyor…');
  try {
    const { blob, counts } = await createBackup();
    const name = `not-yedek-${new Date().toISOString().slice(0, 10)}.notyedek`;
    if (share) {
      const file = new File([blob], name, { type: 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        hide();
        try {
          await navigator.share({ files: [file], title: 'Not Defteri yedeği' });
          markBackedUp();
          ui.toast('Yedek paylaşıldı');
          renderLibrary();
          return;
        } catch (err) {
          if (err?.name === 'AbortError') return;
          // Paylaşım reddedildiyse indirmeye geç.
        }
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    markBackedUp();
    ui.toast(`Yedek indirildi: ${counts.notebooks} defter, ${counts.folders} klasör`);
    renderLibrary();
  } catch (err) {
    console.error(err);
    ui.toast('Yedek alınamadı: ' + (err?.message || err));
  } finally {
    hide();
  }
}

async function restoreFrom(file) {
  let data;
  try {
    data = await readBackup(file);
  } catch (err) {
    ui.toast(err.message);
    return;
  }
  const existing = new Set((await db.getAll('notebooks')).map((n) => n.id));
  const replaced = data.notebooks.filter((n) => existing.has(n.id)).length;
  const ok = await ui.confirmModal({
    title: 'Yedekten geri yüklensin mi?',
    message:
      `${formatDate(data.createdAt)} tarihli yedekte ${data.notebooks.length} defter ve ${data.folders.length} klasör var. ` +
      (replaced ? `Bunlardan ${replaced} defter zaten tablette; onlar yedekteki haliyle değiştirilecek. ` : '') +
      'Yedekte olmayan defterlerine dokunulmaz.',
    ok: 'Geri yükle',
    danger: false,
  });
  if (!ok) return;
  const hide = ui.busy('Geri yükleniyor…');
  try {
    await restoreBackup(data);
    navigator.storage?.persist?.().catch(() => {});
    ui.toast(`${data.notebooks.length} defter geri yüklendi`);
  } catch (err) {
    console.error(err);
    ui.toast('Geri yüklenemedi: ' + (err?.message || err));
  } finally {
    hide();
    renderLibrary();
  }
}

export async function importPdf(blob, fileName = 'Belge.pdf') {
  const hide = ui.busy('PDF açılıyor…');
  let doc = null;
  try {
    doc = await openPdf(blob);
    const sizes = await pageSizes(doc);
    const now = Date.now();
    const fileId = uid();
    const nb = {
      id: uid(),
      folderId: current,
      title: fileName.replace(/\.pdf$/i, '') || 'Belge',
      fileId,
      pages: sizes.map((s, i) => ({ id: uid(), kind: 'pdf', pdfPage: i + 1, w: round2(s.w), h: round2(s.h) })),
      createdAt: now,
      updatedAt: now,
      lastPage: 0,
    };
    nb.thumb = await renderThumb(doc, nb.pages[0], []);
    await db.put('files', { id: fileId, name: fileName, blob });
    await db.put('notebooks', nb);
    navigator.storage?.persist?.().catch(() => {});
    renderLibrary();
    return nb;
  } catch (err) {
    console.error(err);
    ui.toast(isPasswordError(err) ? 'Şifreli PDF\'ler henüz desteklenmiyor' : 'PDF açılamadı: ' + (err?.message || err));
    return null;
  } finally {
    doc?.destroy();
    hide();
  }
}
