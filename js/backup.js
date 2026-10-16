// Yedek dosyası (.notyedek) biçimi:
//   "NDYEDEK1" (8 bayt) | başlık uzunluğu (4 bayt) | başlık JSON | PDF dosyaları art arda
// Başlıkta klasörler, defterler, kalem izleri ve her PDF'in dosya içindeki yeri bulunur.
// PDF'ler metne çevrilmeden olduğu gibi eklendiği için büyük PDF'lerde de bellek şişmez.

import * as db from './db.js';
import { loadJSON, saveJSON } from './util.js';

const MAGIC = 'NDYEDEK1';
const VERSION = 1;

export async function createBackup() {
  const [folders, notebooks, ink, files] = await Promise.all([
    db.getAll('folders'),
    db.getAll('notebooks'),
    db.getAll('ink'),
    db.getAll('files'),
  ]);
  let offset = 0;
  const fileMeta = files.map((f) => {
    const meta = { id: f.id, name: f.name, type: f.blob.type || 'application/pdf', offset, size: f.blob.size };
    offset += f.blob.size;
    return meta;
  });
  const header = new TextEncoder().encode(
    JSON.stringify({ version: VERSION, createdAt: Date.now(), folders, notebooks, ink, files: fileMeta }),
  );
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  const blob = new Blob([MAGIC, len, header, ...files.map((f) => f.blob)], { type: 'application/octet-stream' });
  return { blob, counts: { folders: folders.length, notebooks: notebooks.length } };
}

export async function readBackup(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12 || new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) {
    throw new Error('Bu dosya bir Not Defteri yedeği değil');
  }
  const headerLen = new DataView(head.buffer).getUint32(8);
  const dataStart = 12 + headerLen;
  if (dataStart > file.size) throw new Error('Yedek dosyası eksik ya da bozuk');
  const header = JSON.parse(new TextDecoder().decode(await file.slice(12, dataStart).arrayBuffer()));
  if (header.version > VERSION) throw new Error('Bu yedek uygulamanın daha yeni bir sürümüyle alınmış');
  const files = header.files.map((m) => {
    if (dataStart + m.offset + m.size > file.size) throw new Error('Yedek dosyası eksik ya da bozuk');
    return { id: m.id, name: m.name, blob: file.slice(dataStart + m.offset, dataStart + m.offset + m.size, m.type) };
  });
  return { createdAt: header.createdAt, folders: header.folders, notebooks: header.notebooks, ink: header.ink, files };
}

// Yedekteki her şeyi mevcut verilerin yanına ekler. Aynı defter/klasör zaten varsa yedekteki haliyle değiştirilir;
// yedekte olmayan notlara dokunulmaz.
export async function restoreBackup(data) {
  const existing = await db.getAll('folders');
  const folderIds = new Set([...existing, ...data.folders].map((f) => f.id));
  const folders = data.folders.map((f) => (f.parentId === 'root' || folderIds.has(f.parentId) ? f : { ...f, parentId: 'root' }));
  const notebooks = data.notebooks.map((n) => (n.folderId === 'root' || folderIds.has(n.folderId) ? n : { ...n, folderId: 'root' }));
  // Blob'ları belleğe alıp yazıyoruz; dosyadan dilimlenmiş Blob'lar bazı tarayıcılarda IndexedDB'ye doğrudan yazılamıyor.
  const files = [];
  for (const f of data.files) {
    files.push({ id: f.id, name: f.name, blob: new Blob([await f.blob.arrayBuffer()], { type: f.blob.type }) });
  }
  await db.putMany({ folders, notebooks, ink: data.ink, files });
}

export function lastBackupTime() {
  return loadJSON('nd-backup', { at: 0 }).at;
}

export function markBackedUp() {
  saveJSON('nd-backup', { at: Date.now() });
}
