# waypoint-dji

Mission planner untuk drone DJI consumer (Mini, Air, Mavic, Lito) — memetakan
lahan dari atas, dan mengelilingi objek tegak.

**Status: prototipe.** Ada web app (`web/`) dan CLI (`src/cli.js`). Yang masih
terbuka tetap pertanyaan yang sama sejak awal: apakah file yang kita bikin
benar-benar dibaca DJI Fly? Itu baru bisa dijawab dengan menguji di perangkat.

## Dua jenis angka di aplikasi ini

Ini pembedaan paling penting, dan sengaja tidak disembunyikan di UI:

| | Dari mana | Seberapa bisa dipercaya |
|---|---|---|
| **Spek kamera** (ekuivalen 35 mm, jumlah piksel) | Spec sheet publik | Tinggi — ini yang menentukan GSD dan ketinggian terbang |
| **Kode drone** (`droneEnumValue` dkk) | Tidak dipublikasikan DJI untuk lini consumer | Bertingkat — lihat di bawah |

Semua drone sekarang punya kode terisi: `68/0`. Itu bukan angka karangan —
itu satu-satunya nilai yang pernah terlihat keluar dari DJI Fly sendiri (pada
KMZ yang dibuat DJI Fly di Mini 4 Pro), dan nilai yang sama dilaporkan
memperbaiki impor di Mavic 3 Pro. Tapi "terisi" tidak sama dengan "terbukti",
jadi tiap drone membawa tingkat kepercayaannya sendiri:

| Tingkat | Artinya | Di UI |
|---|---|---|
| Terkunci dari file asli | Dibaca dari KMZ buatan drone kamu sendiri | hijau |
| Diisi sendiri | Kamu ketik manual di panel drone | hijau |
| Teramati di model ini | Pernah terlihat di model yang sama, tapi dari laporan orang | hijau |
| Dipinjam dari model selini | Belum pernah terlihat di model ini | kuning, diperingatkan |
| Belum ada | Tidak ada dasarnya | merah, export ditahan |

## Dua dialek WPML

Ini temuan terpenting di repo ini, dan baru terbukti setelah satu KMZ asli
buatan DJI Fly dibongkar dengan `npm run inspect`.

Dokumentasi WPML yang dipublikasikan DJI itu untuk lini **Enterprise** (DJI
Pilot 2, Cloud API). **DJI Fly menulis bentuk yang berbeda**, dan bedanya
bukan kosmetik:

| | DJI Fly (consumer) | Dokumentasi Enterprise |
|---|---|---|
| namespace | `uav.com/wpmz/1.0.2` | `dji.com/wpmz/1.0.6` |
| `template.kml` | hanya author + waktu + missionConfig, **tanpa satu pun Placemark** | seluruh misi ditulis ulang di sini |
| `payloadInfo` | tidak ditulis sama sekali | ada |
| `takeOffSecurityHeight` | tidak ada | ada |
| `waypointTurnMode` | `...WithContinuityCurvature` | `...WithDiscontinuityCurvature` |
| `useStraightLine` | `0` | `1` |
| `actionGroupMode` | `parallel`, actionId mulai 1 | `sequence`, mulai 0 |
| `distance` / `duration` | ditulis `0`, drone menghitung sendiri | dihitung di file |

Plus dua tag yang hanya ada di file DJI Fly: `waypointHeadingPoiIndex` dan
`waypointGimbalHeadingParam`.

Generator di repo ini sekarang mengikuti **bentuk DJI Fly**, bukan
dokumentasi. Dialek Enterprise masih bisa dipakai lewat `wpml.dialect` di
profil drone.

Pembandingnya ikut disertakan, supaya klaim ini bisa diperiksa sendiri —
bukan dipercaya begitu saja:

```bash
npm run compare -- file-asli-dji-fly.kmz file-bikinan-kita.kmz
```

Dia membandingkan tag **dan nilai**, lalu menandai apa saja yang kita tulis
tapi tidak pernah muncul di file asli. Itu penting: tag yang sama dengan nilai
asing sama berbahayanya dengan tag yang hilang. Contohnya `waypointHeadingMode`
— tag-nya cocok, tapi kita dulu mengisi `smoothTransition` sementara DJI Fly
cuma memakai `followWayline`. Ketahuan lewat alat ini, bukan lewat tebakan.

Konsekuensi praktis: **kode payload tidak menentukan apa pun** di lini
consumer — DJI Fly tidak pernah membacanya. Yang menentukan cuma kode drone.
Dan setelan "ketinggian aman transit" di UI dimatikan, karena angkanya tidak
pernah sampai ke drone; naik-aman sebelum transit diurus
`flyToWaylineMode=safely` plus setelan RTH di drone sendiri.

Kode drone yang salah bukan cuma bikin file ditolak — kemungkinan lebih buruk
adalah file diterima tapi drone dianggap model lain, sehingga batas kecepatan
dan perilaku RTH-nya bukan punya drone kamu. Karena itu export ditahan gerbang
keselamatan sampai kamu mencentang bahwa kamu sadar, atau sampai kodenya
dikunci lewat **Impor KMZ asli** di panel drone.

Mengganti nama file tidak mengubah kode ini: yang dibaca DJI Fly adalah isi
file, bukan namanya.

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

Web app (perencana survei lengkap):

```bash
npm run dev
```

lalu buka http://localhost:5180/web/

Uji hitungan dan gerbang keselamatan tanpa browser:

```bash
npm test
```

Lihat daftar drone yang tersedia beserta status kodenya:

```bash
npm run drones
```

Generate mission test (3 waypoint melingkar di sekitar satu titik):

```bash
npm run gen -- --lat -6.2549323363466 --lng 107.11993938381485 --alt 30 --radius 40 --points 3 --photo --hover 2 --gimbal -90
```

Orbit mengelilingi objek tegak — tugu setinggi 20 m, drone berputar 18 m dari
sumbunya:

```bash
npm run gen -- --lat -6.2549323363466 --lng 107.11993938381485 --orbit --objheight 20 --radius 18
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

### Offline

Service worker menyimpan berkas aplikasi, tile peta, dan jawaban API elevasi —
**sambil peta digeser biasa**, tanpa ada yang perlu ditekan. Sudah diuji dengan
server dimatikan: halaman dimuat ulang dari nol, citra satelit tetap tampil,
dan rencana terbang tetap terhitung.

Pengunduh tile massal **dihapus**. Dulu ada bagian panel "Peta offline" dengan
tombol Unduh area, hitungan tile, dan status cache. Setelah sekian lama, tile
tersimpan tetap 0: satu bagian panel penuh untuk fitur yang tidak pernah
dipakai, sementara bagian yang berguna — tile yang tersimpan sendiri sambil
dipakai — berjalan tanpa UI sama sekali.

Gantinya: cache dibatasi 1500 tile dan 500 respons elevasi, yang paling lama
dibuang lebih dulu. Batas itu perlu justru karena tombol "Hapus cache" ikut
hilang — tanpa batas, cache tumbuh terus tanpa ada yang bisa menghentikannya.

**Batasan penting:** service worker hanya berjalan di konteks aman — `https`
atau `localhost`. Membuka prototipe lewat alamat LAN (`http://192.168.x.x`)
untuk fitur "Buka di HP" berarti tidak ada cache offline di sana. Supaya
keduanya jalan bersamaan di HP, prototipe perlu disajikan lewat https: deploy
ke hosting mana pun yang memberi sertifikat, atau pakai terowongan seperti
`cloudflared tunnel`.

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
karenanya cache offline — tidak jalan di `http://` selain `localhost`.

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


## Fitur perencana (web)

- **Pilih drone** — Mini 3 Pro / 4 Pro / 5 Pro, Lito 1 / X1, Air 3 / 3S,
  Mavic 3 / 3 Classic / 3 Pro / 4 Pro. Tiap drone membawa batas dan kameranya
  sendiri.
- **Pilih lensa dan resolusi foto** — wide / tele / med-tele, 12 MP sampai
  100 MP. Ini bukan sekadar label: mode resolusi penuh punya jeda jepret lebih
  lama, yang langsung membatasi kecepatan terbang dan mengubah lama misi.
- **Preset Cepat / Standar / Detail** — menyimpan ketelitian yang dituju, bukan
  ketinggian mati, jadi artinya tetap sama waktu drone diganti. Geser slider
  apa pun dan presetnya berubah jadi Custom.
- **Pola terbang** — peta datar, 3D bangunan (nadir + miring), atau orbit
  untuk objek tegak. Biayanya ditampilkan sebelum berangkat, bukan setelah.
- **Export dipecah per peran** — file nadir dan file miring terpisah, bukan
  dipotong di titik ke-200 yang kebetulan. Nama filenya menyebutkan isinya.
- **Ketelitian yang jujur untuk kamera miring** — GSD dihitung dari jarak ke
  permukaan, bukan dari ketinggian terbang. Di gimbal -45° bedanya 41%.
- **Ikuti kontur tanah** — plus peringatan kalau lereng menuntut laju naik di
  atas kemampuan drone.
- **Peta 2D / 3D / objek** — medan timbul dari DEM, dan bangunan OSM sebagai
  pemeriksa rintangan.
- **Lanjutkan misi** — dari EXIF foto terakhir, atau ketuk titiknya di peta.
  Jalur dipotong dari situ, mundur satu foto supaya tidak ada petak yang
  bolong, dan drone naik ke ketinggian aman dulu sebelum menyeberang.
- **Peringatan kabel dan tiang** — angka tinggi jaringan listrik Indonesia,
  plus perintah melihat sendiri. Sengaja bukan deteksi otomatis; alasannya di
  bawah.
- **Gerbang keselamatan** — satu pintu yang semua rencana harus lewati.
  Aplikasi tidak pernah diam-diam membetulkan angka; kalau ada yang berbahaya,
  dia bilang.

## Memilih pola menurut fungsinya

Jumlah foto itu **hasil**, bukan setelan:

```
foto ≈ luas ÷ (jarak jalur × jarak foto) × jumlah lintasan
```

Dan karena jarak jalur/foto turun dari ketinggian, dan ketinggian turun dari
GSD — begitu luas dan GSD dipilih, jumlah fotonya sudah ditentukan. Tidak ada
tombol "3D tapi 200 foto".

Dua batas keras yang kebetulan ketemu di titik yang sama: DJI Fly cuma
menerima **200 waypoint per file**, dan baterai Mini 5 Pro kepakai ~22 menit.
Keduanya habis di sekitar **196 foto**. Itu unit alami kerjanya.

| Fungsi | Pola | Gimbal | GSD | Overlap |
|---|---|---|---|---|
| Ortofoto, ukur luas, lihat kondisi | Peta datar | -90° | 2.5–3.5 cm | 75/65 |
| Peta 3D kasar: volume, massing, bentuk atap | Silang | -90° | 3–4 cm | 80/70 |
| Model 3D bangunan, fasad kebaca | **3D bangunan** (satu rencana, 3 file) | -90° + -45° | 1.5–2.5 cm di fasad | 80/70 |
| Objek tunggal: tugu, menara, patung | Orbit objek | per cincin | 0.5–1 cm | langkah sudut 10° |

### Satu rencana, banyak file: yang dipecah itu filenya

Model 3D yang utuh butuh dua-duanya: foto miring untuk fasad, foto nadir untuk
atap dan untuk mengikat skala tanah. Jadi pola 3D bangunan menerbangkan tiga
lintasan — dan di lahan 3.49 ha itu 408 foto, 42 menit, tiga baterai.

Pernah dicoba memecahnya jadi dua POLA terpisah dengan alasan baterai. Itu
keliru tempat, karena dua alasan.

**Pertama, yang berat bukan rencananya — yang berat filenya.** Ini butuh dua
kali salah sebelum benar, dan ketiga caranya diukur di lahan contoh 6.15 ha
(630 foto, batas 200 waypoint per file, minimum mutlak 4 file):

| Cara memecah | File | Ukuran | Baterai kepakai | Masalah |
|---|---|---|---|---|
| Rakus per baterai | 4 | 198/195/194/**43** | 91% | satu file campur −90 dan −45, satu file 43 foto |
| Per lintasan | **6** | 105 ×6 | **48%** | enam kali lepas landas untuk pekerjaan yang muat empat |
| **Per peran** | 5 | 105/105 · 140/140/140 | 66% | — |

Cara rakus memotong di mana pun jatah habis, jadi potongannya jatuh di tengah
lintasan: satu file mencampur foto nadir dan foto miring, dan file terakhir
berisi 43 foto — satu siklus baterai penuh untuk terbang ke lokasi, menjepret
43 kali, lalu pulang.

Memotong per **lintasan** menghilangkan campurannya, tapi karena tiap lintasan
210 titik sementara batasnya 200, tiap lintasan pecah jadi 105+105. Enam file,
dan tiap penerbangan cuma memakai 48% baterai. Lebih buruk, cuma buruknya di
dimensi lain.

Yang dipakai sekarang: per **peran**. Dua lintasan miring punya setelan kamera
yang sama — cuma arah lintasannya menyilang — jadi tidak ada gunanya memisahkan
keduanya. Yang berguna dipisah cuma nadir dari miring, karena itu memang dua
hal berbeda bagi yang menerbangkannya.

### Berapa file untuk lahan seberapa

Jumlah file itu **hasil**, bukan setelan: dia turun dari luas × GSD × pola.
Luas maksimum untuk tiap jumlah file, Mini 5 Pro 12 MP, mode berhenti sejenak:

**3D bangunan** (nadir + 2 miring)

| Preset | GSD di fasad | Tinggi | 2 file | 3 file |
|---|---|---|---|---|
| Cepat | 4.95 cm | 96 m | sampai 4.84 ha | sampai 12.60 ha |
| Standar | 3.54 cm | 68 m | sampai 1.82 ha | sampai 5.29 ha |
| Detail | 2.12 cm | 41 m | sampai 0.42 ha | sampai 1.32 ha |

**Peta datar** (nadir saja)

| Preset | GSD | Tinggi | 1 file | 2 file | 3 file |
|---|---|---|---|---|---|
| Cepat | 3.50 cm | 96 m | sampai 12.60 ha | sampai 28.09 ha | sampai 36.00 ha |
| Standar | 2.50 cm | 68 m | sampai 5.29 ha | sampai 13.32 ha | sampai 22.09 ha |
| Detail | 1.50 cm | 41 m | sampai 1.32 ha | sampai 3.06 ha | sampai 4.84 ha |

Pola 3D bangunan **tidak pernah** muat satu file: dia punya dua peran, dan
nadir tidak pernah digabung dengan miring. Jadi dua file adalah batas bawahnya,
berapa pun kecilnya lahan.

Dua hal yang terbaca dari tabel ini. Pertama, **GSD jauh lebih menentukan
daripada yang terasa**: menaikkan dari Standar ke Detail memangkas luas yang
muat dua file dari 1.82 ha jadi 0.42 ha — empat kali lipat lebih sempit, karena
foto bertambah dengan kuadrat kerapatan. Kedua, kalau sebuah lahan jatuh tepat
di atas ambang, **mengecilkan areanya sedikit** sering lebih murah daripada
menambah satu siklus baterai.

Yang mengikat bergantian antara dua batas: DJI Fly cuma menerima 200 waypoint
per file, dan baterai cuma kepakai ~22 menit dikurangi cadangan transit. Di
preset rapat yang mengikat batas waypoint; di preset renggang yang mengikat
waktu baterai.

**Kedua, dua pola terpisah menyerahkan hal yang tidak boleh diserahkan.**
Pengguna harus mengingat sendiri bahwa misi keduanya memakai area, ketinggian,
overlap, dan **titik lepas landas** yang sama. Ketinggian WPML relatif terhadap
titik lepas landas, jadi berdiri di tempat lain membuat kedua set foto tidak
nyambung. Satu rencana menjamin semuanya identik; dua rencana memindahkan
jaminan itu ke ingatan orang.

Jadi yang dipecah sekarang **filenya**, bukan polanya: file nadir dan file
miring terpisah, dan kelompok yang masih terlalu besar untuk satu baterai
dipecah lagi RATA di dalam kelompoknya sendiri — bukan diisi sampai batas lalu
sisanya jadi remahan. Nama filenya menyebutkan isinya —
`survei-3d-2026-11-09_1dari5-nadir.kmz`, `_3dari5-miring.kmz` — supaya di
folder HP kelihatan mana yang mana tanpa dibuka satu-satu. Nomor urut tetap di
depan karena itu urutan terbang.

Foto nadir dan foto miring tetap digabung di **software olah**, bukan di file
misi: semua foto dari semua file masuk satu project.

Yang tidak berlaku untuk pola banyak lintasan: **Lanjutkan misi**. Kalau
filenya sudah dipecah per lintasan, "lanjut dari titik terakhir" tidak punya
jawaban tunggal — lanjut di file yang mana? Dan memotong daftar waypoint global
akan mengiris lintasan berikutnya yang belum tentu sudah diterbangkan sama
sekali. Kalau satu lintasan gagal di tengah, terbangkan ulang file lintasan itu
saja; itu memang gunanya dipecah. Aplikasi mengatakan ini, bukan diam-diam
mengabaikan titik yang sudah dipilih.

Masih ada pola **Miring saja** untuk kasus nadirnya sudah dipunyai dari misi
lain, tapi tidak ditawarkan di layar — gerbang keselamatannya mengingatkan
bahwa tanpa nadir, modelnya berdiri tapi atapnya meleleh dan ukurannya
mengambang.

### Berapa lama sebenarnya

Satu angka yang sering mengejutkan: **mode jeda lebih menentukan waktu
daripada jumlah foto.** Lahan yang sama, 210 foto:

| Mode | Kecepatan | Waktu | Per foto |
|---|---|---|---|
| Berhenti sejenak | 15.0 m/s | 21m11s | 6.05 s |
| Tanpa jeda | 7.7 m/s | 9m02s | 2.58 s |

Dua kali lipat lebih lama, padahal fotonya sama persis. Sebabnya di mode
berhenti sejenak drone mengerem, berhenti, menjepret, lalu mempercepat lagi di
setiap titik — dan pada ruas sependek jarak antar foto, itu hampir seluruh
waktunya. Jadi kalau rencanamu terasa lama, periksa modenya dulu sebelum
memperkecil lahan.

Yang lebih menentukan hasil daripada jumlah foto, dan tidak muncul di angka
mana pun: tiap permukaan harus terlihat dari minimal tiga sudut berbeda
(400 foto satu arah lebih jelek dari 150 foto empat arah), exposure dan white
balance dikunci manual, dan cahaya yang rata — mendung tipis lebih baik
daripada siang tegak.

## Kamera miring: angka di layar bukan angka yang didapat

Ini bug yang hidup lama di aplikasi ini. `gsdFromAltitude` dan `footprint`
mengandaikan kamera menunduk lurus, padahal pola miring tidak pernah begitu.

Pada gimbal -45° di ketinggian 80 m, jarak ke tengah frame **113 m, bukan
80 m**. Jadi ketelitiannya 4.14 cm/px, bukan 2.93 cm/px yang dilaporkan — dan
karena tidak ada satu pun foto yang nunduk lurus di pola itu, angka 2.93 tidak
mewakili satu piksel pun di dataset. Di -30° melesetnya 100%.

Yang diperbaiki: `surfaceGsd()` menghitung ketelitian di tengah frame dan di
kedua tepinya, dan itulah yang ditampilkan. Satu foto miring membentang jauh:
pada -45° tepi dekatnya 22 m di depan drone dengan 3.04 cm/px, tepi jauhnya
286 m dengan 10.87 cm/px.

Yang **tidak** diubah: jarak jalur dan jarak foto tetap dihitung dari geometri
nadir. Itu disengaja. Frame miring adalah trapesium sedalam ratusan meter, dan
sebagian besar kedalamannya terlalu kasar untuk dipakai. Melebarkan jarak
sampai overlap "pas 80%" dari trapesium penuh justru menjarangkan bagian
dekat-tengah — satu-satunya bagian yang berguna. Hasilnya overlap efektif
lebih tinggi dari yang diminta (79% samping / 93% depan pada -45°), dan itu
memang yang dipakai perencana komersial.

## Dua cara melihat objek

Tiga pola pertama — peta datar, silang, silang + miring — semuanya **memetakan
area**: drone terbang MELINTAS di atas lahan dengan kamera menunduk. Silang +
miring memang menghasilkan model 3D, dan untuk bangunan, lereng, atau kompleks
candi itu pola yang benar.

Objek yang **sempit tapi tinggi** — tugu, menara, patung, cerobong — adalah
masalah yang lain. Informasinya ada di dinding vertikal, bukan di tanah, dan
dinding itu nyaris tidak pernah menghadap kamera yang menunduk dari atas.
Pola **orbit** untuk itu: drone memutari satu sumbu di beberapa tingkat
ketinggian, kamera selalu menghadap ke dalam.

Tiga hal berubah mendasar dibanding grid, dan ketiganya sumber kesalahan
kalau diabaikan:

**GSD ditentukan jarak miring, bukan ketinggian.** Cincin yang curam duduk
lebih jauh dari dinding daripada angka radiusnya. Pada radius 18 m, cincin
terbawah menghasilkan 0.68 cm/px tapi cincin teratas — dari 36 m dengan
gimbal -45° — cuma 0.93 cm/px, karena jarak miringnya 25.5 m.

**Yang mengikat kerapatan adalah langkah sudut, bukan overlap frame.** Begitu
drone bergeser sejauh s di keliling, sudut dia memandang objek berubah s/R.
Di objek sempit, frame jauh lebih lebar daripada objeknya: pada radius 18 m
frame-nya 27 m sementara tugunya cuma 5 m. Overlap frame 80% di situ cuma
menghasilkan 21 foto per cincin dengan loncatan sudut 17° — angka di layar
kelihatan sehat, hasilnya tetap gagal menyambung. Bawaannya 10° per langkah,
jadi 36 foto per cincin.

**Arah hadap tidak bisa followWayline.** Di grid, menghadap arah jalur itu
persis yang benar. Di orbit, menghadap arah jalur berarti kamera menyorot
tangensial dan objeknya lewat di pinggir frame. Tiap titik butuh sudut
hadapnya sendiri — lihat "Yang belum diverifikasi" di bawah.

Tinggi tiap cincin tidak bebas: dia terkunci ke titik bidiknya,
`tinggi = bidik + radius × tan(|pitch|)`. Tanpa kunci itu, cincin curam akan
membidik langit di atas puncak atau tanah di depan kaki, dan tidak ada yang
memberitahu di layar.

Satu hal yang drone memang tidak bisa: **kaki objek**, kira-kira 0-3 m
terbawah. Cincin terendah pun membidik di atas itu, dan menurunkannya berarti
mengelilingi tugu di ketinggian pohon dan kabel. Keliling bagian itu dengan
kamera tangan, lalu gabungkan di software olah yang sama.

## Kabel listrik: kenapa angka, bukan deteksi

Kabel adalah satu-satunya rintangan yang benar-benar mematikan dan **tidak
terlihat sensor drone**. Dia juga tidak ada di peta bangunan, dan tidak ada di
data elevasi.

Pernah dipertimbangkan menariknya dari OpenStreetMap, seperti yang sudah
dilakukan untuk bangunan. Itu dibatalkan, dan bukan karena susah dikerjakan:
cakupan OSM untuk jaringan **distribusi** di Indonesia — kabel di pinggir jalan
kampung dan perumahan, yang justru paling sering menjatuhkan drone — nyaris
nol. Jaringan transmisi tegangan tinggi dan menara telekomunikasi cakupannya
lumayan, tapi bukan itu yang paling sering kena.

Peta yang kosong karena datanya tidak ada akan terbaca sebagai "aman". Itu
memindahkan kewaspadaan pengguna ke data yang tidak ada isinya — lebih
berbahaya daripada tidak ada peta sama sekali.

Jadi yang diberikan: angka yang memang sudah diketahui, dan perintah melihat
sendiri. Drone tidak bisa melihat kabel; manusia bisa.

| Jaringan | Tinggi tiang | Kabel menggantung |
|---|---|---|
| JTR — tegangan rendah, ke rumah | 9 m | ~7–9 m |
| JTM — tegangan menengah 20 kV | 11–13 m | ~9–11 m |
| Tiang trafo (GTT) | 13 m | — |

**Di atas 15 m, seluruh jaringan distribusi sudah terlewati.** Angka itu dipakai
sebagai batas praktis, dengan margin di atas angka tertinggi yang pernah
disebut sumber mana pun.

Seberapa pasti? Tidak terlalu, dan itu ikut ditulis di gerbangnya. Sumber tidak
seragam: jurnal teknik mengutip SPLN 1997 untuk panjang tiang 9/11/13 m, satu
portal berita menyebut tiang TR ~7.5 m dan TM ~10.8 m, sementara produsen tiang
baja menyebut JTM 12–15 m.

**SUTT dan SUTET kategori lain, dan di situ "terbang di atasnya" bukan
jawabannya.** Menaranya puluhan meter, dan yang diatur justru ruang bebasnya:
untuk SUTET 500 kV sekitar 22 m mendatar dari tapak menara untuk sirkit tunggal
dan 17 m untuk sirkit ganda. Aturan yang dirujuk pun berbeda antar sumber —
sebagian masih Permen ESDM 18/2015, sementara PLN menyebut Permen ESDM 13/2021.
Kalau ada menara transmisi di sekitar lahan: hindari koridornya.

Gerbangnya menilai titik **terendah** yang benar-benar diperintahkan, bukan
angka di slider — dengan ikut kontur drone turun relatif terhadap tanah di
bagian lahan yang lebih tinggi, dan di orbit tiap cincin punya ketinggiannya
sendiri.

## Dua mode

**Rencanakan** — gambar lahan, aplikasi menghitung jalurnya. Ini mode yang
dipakai untuk mapping: GSD, overlap, pola silang, pembagian baterai.

**Edit KMZ** — buka file yang sudah ada, geser titiknya, ubah ketinggian,
kecepatan, gimbal, atau setelan RTH, lalu simpan lagi.

Mode edit sengaja tidak membangun ulang file. File diperlakukan sebagai teks
dan hanya angka yang kamu sentuh yang diubah; sisanya — termasuk tag yang
belum kita pahami — tetap di tempatnya huruf per huruf. Alasannya: file
buatan DJI Fly adalah satu-satunya bentuk yang terbukti diterima drone, dan
menulis ulang berarti mempertaruhkan jaminan itu demi kerapian yang tidak ada
gunanya.

Dibuktikan di `npm test`: membuka lalu menyimpan tanpa perubahan menghasilkan
berkas yang identik, dan mengubah ketinggian 3 titik hanya menyentuh 6 baris.

Mode edit tidak menampilkan GSD, overlap, atau jumlah baterai. Titik dalam
file sembarang tidak punya pola jalur, jadi angka-angka itu tidak punya arti
di sana.

## Yang belum diverifikasi

Jujur soal ini lebih berguna daripada daftar fitur:

- **Kode drone** baru terbukti langsung untuk Mini 4 Pro, dan itu pun dari
  laporan orang lain, bukan dari file yang kita pegang. Sepuluh model lainnya
  meminjam nilai yang sama. Satu-satunya cara menaikkannya jadi pasti: export
  KMZ asli dari DJI Fly lalu impor di aplikasi.
- **Arah hadap per titik di orbit.** Semua file acuan yang kita punya —
  buatan DJI Fly maupun generator pihak ketiga — memakai `followWayline`,
  yang justru salah untuk orbit. Dua bentuk disediakan dan dua-duanya belum
  terbukti: `smoothTransition` dengan sudut mutlak dihitung per titik
  (bawaan, karena yang diminta ke drone paling sederhana), dan `towardPOI`
  dengan satu titik pusat di `waypointPoiPoint`. Kalau drone mengelilingi
  objek tapi kameranya tidak menghadap ke dalam, coba bentuk satunya sebelum
  mengejar sebab lain.
- **Aksi foto dan hover** (`takePhoto`, `hover`, `multipleDistance`,
  `actionTriggerParam`, `hoverTime`) adalah satu-satunya bagian
  yang belum bisa dicocokkan dengan file asli, karena misi contoh yang kita
  punya tidak memakai aksi foto sama sekali. Bentuknya mengikuti dokumentasi
  Enterprise, dibungkus gaya DJI Fly. Kalau drone terbang rapi tapi tidak
  menjepret, inilah tersangkanya — jalan keluarnya mode stop & shoot.
- **Batas 200 waypoint** di DJI Fly belum dikonfirmasi.
- **Daya tahan baterai Lito X1** dan **dimensi piksel 100 MP Mavic 4 Pro**
  diturunkan, bukan dari spec resmi. Keduanya ditandai di
  `profiles/drones.json`.
- **Ekuivalen 35 mm Lito 1** diturunkan dari FOV, bukan angka resmi.
- **Data elevasi** resolusinya ~90 m: tahu bukit, tidak tahu pohon, tiang,
  menara, atau kabel.
- **Tinggi bangunan OSM** sering kurang dari aslinya, dan bangunan tanpa data
  tinggi sengaja tidak digambar daripada ditebak.
