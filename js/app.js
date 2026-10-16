import { initLibrary, renderLibrary } from './library.js';
import { initEditor, openEditor, closeEditor, isEditorOpen } from './editor.js';
import { toast } from './ui.js';

const libraryEl = document.getElementById('library');
const editorEl = document.getElementById('editor');

// Defter açıkken tabletin "geri" tuşu kitaplığa dönsün diye tarayıcı geçmişine bir adım ekliyoruz.
async function showNotebook(id) {
  libraryEl.classList.add('hidden');
  editorEl.classList.remove('hidden');
  history.pushState({ notebook: id }, '');
  try {
    await openEditor(id);
  } catch (err) {
    console.error(err);
    toast('Defter açılamadı: ' + (err?.message || err));
    history.back();
  }
}

async function showLibrary() {
  if (isEditorOpen()) await closeEditor();
  editorEl.classList.add('hidden');
  libraryEl.classList.remove('hidden');
  renderLibrary();
}

window.addEventListener('popstate', showLibrary);

initLibrary({ onOpenNotebook: showNotebook });
initEditor({ onBack: () => history.back() });
history.replaceState({}, '');
renderLibrary();

// Tarayıcıdan "kalıcı depolama" iste: yer azaldığında notlar otomatik silinmesin.
navigator.storage?.persist?.().catch(() => {});

// Çevrimdışı çalışma (yalnızca https ya da localhost üzerinden açıldığında mümkün).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker kaydedilemedi', err));
}
