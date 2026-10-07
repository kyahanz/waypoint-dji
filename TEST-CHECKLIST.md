# Fase 0 — Checklist Uji Lapangan

Tujuan: menjawab **satu pertanyaan go/no-go** — bisakah DJI Fly di Mini 5 Pro
membaca file `.kmz` yang kita generate sendiri?

Kalau jawabannya **tidak**, seluruh konsep "web app → export file → terbang"
harus di-pivot sebelum kita bangun apa pun di atasnya.

---

## Urutan kerja (jangan dibalik)

Langkah A dikerjakan **duluan**. Kita tidak mau menebak-nebak format kalau
ground truth-nya bisa diambil langsung dari HP sendiri.

---

## A. Ambil ground truth dari DJI Fly

### A1. Bikin mission manual di DJI Fly

1. Nyalakan drone + RC, tunggu GPS lock.
2. Masuk mode **Waypoint Flight**.
3. Bikin mission sederhana: **3 waypoint**, altitude 30 m, aksi "ambil foto" di tiap titik.
4. **Simpan** mission-nya. Beri nama yang gampang dicari, misal `GROUNDTRUTH1`.
5. Tidak perlu diterbangkan — yang kita butuh cuma file-nya.

### A2. Cari file-nya di HP

**Android** — cek kandidat lokasi berikut pakai file manager
(disarankan pakai aplikasi seperti *Solid Explorer* / *CX File Explorer*,
karena File Manager bawaan sering tidak bisa masuk folder `Android/data`):

```
/Android/data/dji.go.v5/files/waypoint/
/Android/data/dji.go.v5/files/
/DJI/dji.go.v5/KMZ/
/DJI/dji.go.v5/
```

Yang dicari: file `.kmz` (atau folder berisi `template.kml` + `waylines.wpml`).

> Kalau `Android/data` tidak bisa dibuka sama sekali di Android 13+, colok HP ke
> PC pakai kabel dan akses lewat MTP, atau pakai `adb`:
> ```bash
> adb shell find /sdcard -iname "*.kmz"
> ```

**iOS** — buka app **Files**:

```
On My iPhone → DJI Fly → (cari folder waypoint / kmz)
```

> Kalau DJI Fly **tidak muncul** di "On My iPhone", artinya app-nya tidak
> membuka sandbox-nya ke Files. Ini sinyal kuat bahwa **import file di iOS
> tidak mungkin** — catat ini, karena langsung menentukan arsitektur produk.
> Alternatif cek: colok ke Mac/PC → iTunes/Finder → File Sharing → DJI Fly.

### A3. Kirim file itu ke PC dan bedah

```bash
npm run inspect -- "path/ke/GROUNDTRUTH1.kmz" --dump out/groundtruth
```

Lalu bandingkan dengan punya kita:

```bash
diff -u out/groundtruth/wpmz/template.kml out/test-mission.unpacked/wpmz/template.kml
```

**Yang paling penting dicatat dari hasil inspect:**

| Yang dicari | Kenapa penting |
|---|---|
| `xmlns:wpml="..."` versinya berapa | Kita pakai `1.0.6`, mungkin beda |
| `droneEnumValue` / `droneSubEnumValue` | Nilai Mini 5 Pro yang sebenarnya — kita masih nebak `68` |
| `payloadEnumValue` / `payloadSubEnumValue` | Sama, masih tebakan |
| Nama file di dalam arsip | Mungkin bukan `wpmz/template.kml` |
| Tag yang ada di file DJI tapi tidak ada di file kita | Field wajib yang kita lewatkan |
| Tag yang ada di file kita tapi tidak ada di file DJI | Field asing yang mungkin bikin parser nolak |

Setelah itu, salin nilai aslinya ke `profiles/mini5pro.json`.

---

## B. Generate & uji file kita

### B1. Generate

```bash
npm run gen -- --lat -6.2549323363466 --lng 107.11993938381485 --alt 30 --radius 40 --points 3 --photo --hover 2 --gimbal -90
```

Output: `out/test-mission.kmz`

> Ganti `--lat` / `--lng` kalau lokasi terbangnya pindah. Waypoint disebar
> melingkar radius 40 m dari titik itu — pastikan area sekelilingnya lapang.

### B2. Transfer ke HP

Taruh di **lokasi yang sama persis** dengan tempat file ground truth ditemukan di langkah A2.

### B3. Tes import

1. Buka DJI Fly → Waypoint Flight → daftar mission tersimpan.
2. **Muncul atau tidak?**

| Hasil | Artinya | Tindakan |
|---|---|---|
| Muncul & bisa dibuka, waypoint benar | **GO** | Lanjut Fase 1 |
| Muncul tapi error waktu dibuka | Format hampir benar | Diff lagi vs ground truth, perbaiki field |
| Tidak muncul sama sekali | Lokasi file salah, atau ada index/database internal | Cek apakah ada file index di folder yang sama |
| DJI Fly crash | Field rusak / tipe data salah | Mulai dari file ground truth, ubah 1 field per iterasi |

---

## C. Uji terbang

**Hanya kalau B3 lolos.** Jangan skip langsung ke sini.

### Sebelum terbang

- [ ] Area lapang, tidak ada orang, tidak ada kabel listrik
- [ ] Bukan kawasan KKOP / zona larangan (cek di DJI Fly, akan muncul warning)
- [ ] Ketinggian ≤ 120 m AGL
- [ ] Visual line of sight terjaga
- [ ] Baterai penuh
- [ ] **Jempol siap di tombol pause** — ini mission dari file yang belum pernah teruji

### Yang diverifikasi saat terbang

- [ ] Drone naik ke `takeOffSecurityHeight` dulu sebelum jalan
- [ ] Urutan waypoint sesuai (0 → 1 → 2)
- [ ] Ketinggian aktual = 30 m relatif titik take-off
- [ ] Gimbal menunduk ke −90° (nadir)
- [ ] Hover ~2 detik di tiap titik
- [ ] Foto kejepret di tiap waypoint (cek galeri setelah mendarat)
- [ ] Finish action `goHome` berjalan

### Setelah mendarat

- [ ] Cek EXIF foto: ada GPS? altitude-nya masuk akal?
  ```bash
  exiftool -GPSLatitude -GPSLongitude -GPSAltitude -GimbalPitchDegree out/foto/*.JPG
  ```
  Ini penting — kalau foto tidak geotagged dengan benar, pipeline ortofoto di
  Fase 3 tidak akan jalan.

---

## Catat hasilnya

Isi di `HASIL-TEST.md` (bikin baru): tanggal, versi DJI Fly, versi firmware
drone, hasil tiap langkah, dan screenshot error kalau ada. Versi firmware
penting — kalau nanti format berubah setelah update, kita tahu kapan patokannya.
