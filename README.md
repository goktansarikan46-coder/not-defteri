# Not Defteri

Tablette kalemle PDF üzerine not almak için kişisel bir web uygulaması (PWA).

- PDF açıp üzerine kalem / fosforlu kalem ile yazma, silgi, geri al
- PDF sayfalarının arasına boş sayfa ekleme, sayfa silme
- Klasörler ve iç içe klasörler
- Notlarla birlikte PDF olarak dışa aktarma
- Tüm verinin tek dosyaya yedeklenmesi ve geri yüklenmesi

Notlar ve PDF'ler yalnızca cihazın kendi tarayıcı depolamasında (IndexedDB) tutulur, hiçbir sunucuya gönderilmez.

## Çalıştırma

- **Yayındaki sürüm:** GitHub Pages adresini tablette Chrome ile açıp menüden "Uygulamayı yükle" seç.
- **Bilgisayarda:** `Baslat.bat` dosyasına çift tıkla (Python gerekir), uygulama `http://localhost:5173` adresinde açılır.

Üçüncü taraf kütüphaneler `vendor/` klasöründedir: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) ve [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT).
