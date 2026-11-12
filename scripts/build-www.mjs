// Android uygulaması için web dosyalarını www/ klasörüne kopyalar (Capacitor oradan alır).
// sw.js kopyalanmaz: APK'da dosyalar zaten telefonun içinde, çevrimdışı önbelleğe gerek yok.
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const OUT = 'www';
const ITEMS = ['index.html', 'styles.css', 'manifest.webmanifest', 'js', 'vendor', 'icons'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const item of ITEMS) cpSync(item, `${OUT}/${item}`, { recursive: true });
console.log('www/ hazır');
