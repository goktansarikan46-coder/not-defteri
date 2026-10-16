import { initLibrary, renderLibrary, currentFolder, showFolder } from './library.js';
import { initEditor, openEditor, closeEditor, isEditorOpen } from './editor.js';
import { toast } from './ui.js';

const libraryEl = document.getElementById('library');
const editorEl = document.getElementById('editor');

// Gezinme tarayıcı geçmişiyle yapılıyor: klasöre girmek ve defter açmak geçmişe bir adım ekler.
// Tabletin geri tuşu / kenardan kaydırma hareketi böylece önce defteri kapatır, sonra klasörlerden
// birer birer geri çıkar; uygulama ancak kitaplığın en başındayken kapanır.
async function showNotebook(id) {
  libraryEl.classList.add('hidden');
  editorEl.classList.remove('hidden');
  history.pushState({ folder: currentFolder(), notebook: id }, '');
  try {
    await openEditor(id);
  } catch (err) {
    console.error(err);
    toast('Defter açılamadı: ' + (err?.message || err));
    history.back();
  }
}

window.addEventListener('popstate', async (e) => {
  if (isEditorOpen()) await closeEditor();
  editorEl.classList.add('hidden');
  libraryEl.classList.remove('hidden');
  showFolder(e.state?.folder);
});

initLibrary({ onOpenNotebook: showNotebook });
initEditor({ onBack: () => history.back() });

// Uygulama en son açık kalan klasörde başlar; geri hareketi oradan kitaplığın başına döner.
const startFolder = currentFolder();
history.replaceState({ folder: 'root' }, '');
if (startFolder !== 'root') history.pushState({ folder: startFolder }, '');
renderLibrary();

// Tarayıcıdan "kalıcı depolama" iste: yer azaldığında notlar otomatik silinmesin.
navigator.storage?.persist?.().catch(() => {});

// Çevrimdışı çalışma (yalnızca https ya da localhost üzerinden açıldığında mümkün).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker kaydedilemedi', err));
}
