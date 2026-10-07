# waypoint-dji

Mission planner untuk DJI Mini 5 Pro — fokus mapping / ortofoto.

**Status: Fase 0 (spike).** Belum ada web app. Yang ada baru CLI untuk
menjawab satu pertanyaan: bisakah kita bikin file mission yang dibaca DJI Fly?

## Kenapa pendekatannya begini

DJI Mobile SDK tidak mendukung lini Mini consumer, jadi tidak ada cara untuk
menerbangkan Mini 5 Pro dari aplikasi buatan sendiri. Satu-satunya jalur yang
tersisa: **generate file mission** (`.kmz` berisi WPML) dan impor ke DJI Fly,
yang punya fitur Waypoint Flight bawaan.

```
Web app (rencana)  →  export .kmz  →  HP  →  DJI Fly  →  terbang
                                                           ↓
       viewer ortofoto  ←  NodeODM  ←  upload foto geotagged
```

Fase 0 memvalidasi anak panah `export .kmz → DJI Fly`. Kalau itu gagal, sisanya
tidak ada gunanya dibangun.

## Butuh apa

Node.js 18+. Tidak ada dependency — ZIP writer/reader ditulis sendiri di atas
`zlib` bawaan Node.

## Pakai

Generate mission test (3 waypoint melingkar di sekitar satu titik):

```bash
npm run gen -- --lat -6.2549323363466 --lng 107.11993938381485 --alt 30 --radius 40 --points 3 --photo --hover 2 --gimbal -90
```

Lihat semua opsi:

```bash
npm run gen -- --help
```

Bedah file `.kmz` apa pun — termasuk yang di-export DJI Fly:

```bash
npm run inspect -- out/test-mission.kmz
npm run inspect -- "mission-dari-hp.kmz" --dump out/groundtruth
```

## Prototipe UI

Perencana survei yang jalan di browser — peta satelit, gambar poligon lahan,
atur GSD/overlap, lihat jalur grid dan estimasinya, export KMZ.

```bash
python -m http.server 5173
```

Lalu buka <http://localhost:5173/web/>.

**Agar fitur "Buka di HP" berfungsi**, buka prototipe lewat alamat LAN komputer,
bukan `localhost` — QR berisi alamat yang sedang dibuka, dan `localhost` di HP
menunjuk ke HP itu sendiri. Cari alamatnya:

```bash
ipconfig
```

Lalu buka `http://<alamat-IPv4>:5173/web/` di komputer. Server Python sudah
mendengarkan di semua antarmuka, jadi tidak ada yang perlu diubah — tapi Windows
Firewall mungkin meminta izin saat HP pertama kali menyambung.

Tanpa build step, tanpa npm install. Peta pakai MapLibre GL JS dari CDN, sisanya
modul ES lokal — modul hitungan yang sama persis dengan CLI, jadi angka di layar
= angka yang masuk ke file.

Yang sudah jalan:

**Area**
- Gambar poligon dengan klik; Enter atau klik dua kali untuk selesai
- Geser titik sudut untuk mengubah bentuk
- Klik pegangan di tengah sisi untuk menyisipkan titik baru
- Klik kanan atau Shift+klik untuk menghapus titik (minimal tetap 3)
- Ctrl+Z membatalkan, Ctrl+Shift+Z mengulangi (riwayat 100 langkah,
  mencakup geser, sisip, dan hapus titik — bukan cuma titik terakhir)
- Cari lokasi lewat nama, atau tempel koordinat Google Maps langsung
- Tombol lokasi saya, basemap satelit/jalan, overlay label
- Sumber citra bisa diganti: Esri (tanpa kunci, mentok zoom 19), Mapbox
  Satellite (zoom 22) atau MapTiler, dengan kunci sendiri yang tersimpan lokal

**Perencanaan**
- GSD ↔ ketinggian terbang terhubung dua arah
- Overlap depan/samping, arah jalur bisa diputar
- "Ikuti sisi terpanjang" mencari arah jalur paling hemat belokan
- Mode "jalan terus" (jepret per jarak) vs "stop & shoot"
- Jalur lawnmower serpentine, otomatis terpotong mengikuti bentuk poligon
- Buffer tepi: area terbang dilebarkan keluar dari batas lahan (default 1×
  jarak jalur) supaya pinggiran ortofoto tidak melengkung karena cuma
  terpotret dari satu sisi. Biayanya dalam foto dan menit ditampilkan langsung
- Dua angka luas: lahan yang digambar, dan area yang benar-benar diterbangi
  (yang menentukan waktu dan jumlah foto)
- **Terrain following**: ketinggian tiap waypoint disesuaikan dengan elevasi
  tanah supaya AGL — dan karenanya GSD — tetap konsisten di medan miring
- Titik lepas landas (penanda H) otomatis mengikuti tengah lahan sampai
  digeser sendiri, dan bisa disembunyikan sama sekali. Ini **asumsi
  perencanaan, bukan isi file** — KMZ tidak memuat titik home, DJI Fly memakai
  lokasi lepas landas yang sebenarnya. Gunanya untuk menghitung transit
  pergi-pulang, cadangan baterai, dan jarak VLOS
- Estimasi waktu yang memperhitungkan akselerasi dan belokan, bukan sekadar
  jarak dibagi kecepatan
- Pembagian otomatis jadi beberapa sortie, berwarna di peta plus rincian
  waktu dan jumlah foto per baterai
- Peringatan: batas 120 m, jarak VLOS, limit kecepatan rolling shutter,
  jumlah waypoint, jumlah baterai

**Keluaran**
- "Buka di HP": rencana diringkas ke dalam URL dan ditampilkan sebagai QR,
  jadi perencanaan bisa dipindah ke HP tanpa server atau akun
- Seluruh rencana tersimpan di hash URL — refresh dan tombol back tidak
  menghilangkan pekerjaan
- Export KMZ, satu file per baterai
- Export GeoJSON (area, titik home, jalur) untuk dibuka di QGIS
- Simpan dan buka kembali project dari penyimpanan browser

### Catatan terrain following

Data elevasi diambil dari Open-Meteo Elevation API (gratis, tanpa kunci,
Copernicus DEM GLO-90). **Resolusinya ~90 m** — cukup untuk mengikuti lereng
bukit, tidak cukup untuk mengikuti tanggul atau selokan. Jangan jadikan
pengganti melihat medan sendiri.

Karena WPML memakai `relativeToStartPoint`, perintah ketinggian dihitung
sebagai `AGL + (elevasi titik − elevasi titik lepas landas)`. Akibatnya titik
lepas landas jadi penting di medan miring, dan aplikasi memperingatkan dua
kasus gagal: perintah ketinggian menembus batas 120 m, dan perintah ketinggian
negatif (lahan lebih rendah dari tempat lepas landas).

### Peta offline

Service worker menyimpan berkas aplikasi, tile peta, dan jawaban API elevasi.
Tombol **Unduh area** mengambil tile zoom 13–19 yang menutupi area terbang,
dibatasi 4 permintaan sekaligus karena penyedia tile gratis melarang unduhan
massal. Area 6 ha butuh ~150 tile (~5 MB).

Sudah diuji dengan server dimatikan: halaman dimuat ulang dari nol, citra
satelit tetap tampil, dan rencana terbang tetap terhitung.

**Batasan penting:** service worker hanya berjalan di konteks aman — `https`
atau `localhost`. Membuka prototipe lewat alamat LAN (`http://192.168.x.x`)
untuk fitur "Buka di HP" berarti peta offline **tidak aktif** di sana, dan
aplikasi mengatakannya terang-terangan. Supaya keduanya jalan bersamaan di HP,
prototipe perlu disajikan lewat https: deploy ke hosting mana pun yang
memberi sertifikat, atau pakai terowongan seperti `cloudflared tunnel`.

Belum ada: GCP, upload foto.

## Live

<https://waypoint-dji.vercel.app>

## Deploy

Saat pengembangan, `web/` mengimpor modul lewat `../src/` supaya CLI dan web
benar-benar memakai berkas yang sama. Path itu keluar dari satu root, jadi
tidak bisa dihosting apa adanya. `build.js` menyusunnya jadi satu pohon:

```bash
node build.js
```

Hasilnya di `dist/` — statis murni, tanpa bundler, siap diunggah ke hosting
mana pun:

```bash
node build.js
cd dist && npx vercel deploy --prod
```

Vercel CLI butuh Node 18+. Tautan proyek disimpan di `dist/.vercel/` dan
sengaja dipertahankan oleh `build.js` saat folder itu dibangun ulang —
tanpa itu, setiap build memutus tautannya dan deploy berikutnya membuat
proyek baru.

`build.js` juga menulis `dist/.vercelignore` yang mengecualikan `.env*`:
Vercel CLI menaruh token OIDC di `dist/.env.local` saat menautkan proyek, dan
itu kredensial yang tidak boleh ikut terunggah.

Build ini juga menyalin `web/vendor/maplibre-gl.css` alih-alih mengambilnya
dari CDN, karena sebagian host (termasuk Claude Artifacts) memblokir
stylesheet lintas situs lewat CSP.

Hosting ber-https penting bukan cuma untuk keamanan: service worker — dan
karenanya peta offline — tidak jalan di `http://` selain `localhost`.

## Struktur

```
src/zip-core.js   Penulis ZIP murni, jalan di Node maupun browser
src/zip.js        Binding Node: ZIP terkompresi + pembaca
src/geo.js        Helper geodesi (destination, distance, pathLength)
src/survey.js     Fotogrametri (GSD, overlap, limit kecepatan), buffer, grid
src/terrain.js    Data elevasi untuk terrain following (khusus browser)
src/wpml.js       Generator template.kml + waylines.wpml
src/cli.js        CLI generate mission
src/inspect.js    Bedah isi .kmz, tampilkan semua tag wpml
web/index.html    Kerangka UI
web/app.js        Orkestrasi: peta, panel, perencanaan, export
web/draw.js       Penyuntingan poligon (tambah/geser/sisip/hapus titik)
web/store.js      Simpan project di browser + pencarian lokasi
web/kmz.js        Pembungkus KMZ untuk browser
web/offline.js    Perhitungan & pengunduhan tile offline
web/sw.js         Service worker: cache aplikasi, tile, dan data elevasi
web/vendor/       Aset pihak ketiga yang disalin lokal (CSS MapLibre)
build.js          Menyusun dist/ untuk hosting statis
web/style.css     Gaya tampilan
profiles/         Profil drone: enum, spek kamera, batasan
out/              Hasil generate (.kmz + versi mentah untuk di-diff)
```

## Yang masih tebakan

Spec WPML dipublikasikan DJI untuk lini Enterprise. Implementasi di DJI Fly
(consumer) belum terkonfirmasi identik. Yang belum pasti:

- `droneEnumValue` / `payloadEnumValue` untuk Mini 5 Pro — sekarang diisi `68`, asal tebak
- Versi namespace WPML yang dipakai DJI Fly — kita pakai `1.0.6`
- Nama & struktur path di dalam arsip (`wpmz/template.kml`)
- Apakah DJI Fly iOS bisa mengimpor file eksternal sama sekali

Semuanya diselesaikan dengan cara yang sama: ambil file asli dari DJI Fly,
jalankan `npm run inspect`, salin nilai aslinya ke `profiles/mini5pro.json`.

## Langkah berikutnya

Ikuti [TEST-CHECKLIST.md](TEST-CHECKLIST.md).

## Catatan keselamatan & regulasi

Indonesia: batas 120 m AGL, wajib VLOS, hindari KKOP bandara. Registrasi dan
izin lewat SIDOPI-GO (DGCA). File mission hasil generator ini **belum teruji** —
selalu siap ambil alih manual saat menerbangkannya.
