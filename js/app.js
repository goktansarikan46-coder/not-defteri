import { initLibrary, currentFolder, showFolder } from './library.js';
import { APP_VERSION } from './util.js';
import { initEditor, openEditor, closeEditor, isEditorOpen, closeOverlays, openSettings } from './editor.js';
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
  // Defterin içinde açık bir ekran (ör. tüm sayfalar) varsa geri hareketi önce onu kapatır.
  if (isEditorOpen() && closeOverlays()) return;
  if (isEditorOpen()) await closeEditor();
  editorEl.classList.add('hidden');
  libraryEl.classList.remove('hidden');
  showFolder(e.state?.folder);
});

initLibrary({ onOpenNotebook: showNotebook, onOpenSettings: openSettings });
initEditor({ onBack: () => history.back() });

// Uygulama her açılışta kitaplığın başında başlar. Dokunuş olmadan geçmişe adım eklemek (eski davranış)
// Chrome tarafından "atlanabilir" sayılır ve tabletin geri hareketi uygulamayı doğrudan kapatır.
// Bu yüzden geçmişe yalnızca kullanıcı bir klasöre / deftere dokunduğunda adım ekleniyor.
history.replaceState({ folder: 'root' }, '');
showFolder('root');
renderVersion();

function renderVersion() {
  const el = document.createElement('div');
  el.className = 'app-version';
  el.textContent = 'Sürüm ' + APP_VERSION;
  libraryEl.append(el);
}

// Tarayıcıdan "kalıcı depolama" iste: yer azaldığında notlar otomatik silinmesin.
navigator.storage?.persist?.().catch(() => {});

// Çevrimdışı çalışma (yalnızca https ya da localhost üzerinden açıldığında mümkün).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker kaydedilemedi', err));
}
