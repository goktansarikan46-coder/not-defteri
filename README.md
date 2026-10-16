# Not Defteri

**Uygulamayı aç:** https://goktansarikan46-coder.github.io/not-defteri/

Tablette bu adresi Chrome'un adres çubuğuna yaz, sonra ⋮ menüsünden "Uygulamayı yükle"yi seç.

Tablette kalemle PDF üzerine not almak için kişisel bir web uygulaması (PWA).

- PDF açıp üzerine kalem / fosforlu kalem ile yazma (basınca duyarlı, 8+6 kalınlık, favori kalemler)
- Kalemi bekletince düz çizgi, daire, dikdörtgen, üçgene dönüşen şekiller
- Silgi: tüm çizgi ya da kısmi; iki parmakla dokun = geri al, üç parmak = yinele
- Kement: seç, taşı, büyüt, renk değiştir, çoğalt, kopyala-yapıştır, sil
- Metin kutusu ve resim ekleme (galeri / kamera)
- Sayfa şablonları (boş, çizgili, kareli, noktalı); araya sayfa ekleme, çoğaltma, silme
- Tüm sayfalar ekranı: sürükleyerek sıralama, yer imleri
- PDF içinde ve kitaplıkta arama (Türkçe karakterlere duyarsız)
- Renkli klasörler ve iç içe klasörler
- Notlarla birlikte PDF olarak dışa aktarma
- Tüm verinin tek dosyaya yedeklenmesi ve geri yüklenmesi

Notlar ve PDF'ler yalnızca cihazın kendi tarayıcı depolamasında (IndexedDB) tutulur, hiçbir sunucuya gönderilmez.

## Çalıştırma

- **Yayındaki sürüm:** GitHub Pages adresini tablette Chrome ile açıp menüden "Uygulamayı yükle" seç.
- **Bilgisayarda:** `Baslat.bat` dosyasına çift tıkla (Python gerekir), uygulama `http://localhost:5173` adresinde açılır.

Üçüncü taraf kütüphaneler `vendor/` klasöründedir: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) ve [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT).
