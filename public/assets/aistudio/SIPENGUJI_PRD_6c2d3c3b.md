# PRODUCT REQUIREMENTS DOCUMENT (PRD)
## SIPENGUJI — Sistem Informasi Pengawasan Ujian Madrasah

| Item | Keterangan |
|---|---|
| Nama dokumen | PRD SIPENGUJI |
| Versi | 1.0 (Draf untuk persetujuan) |
| Tanggal | 27 November 2026 |
| Platform pengembangan | Google AI Studio |
| Status | Menunggu persetujuan Admin / pemilik proyek |
| Penanggung jawab dokumen | Tim Produk SIPENGUJI |

### Riwayat Revisi

| Versi | Tanggal | Perubahan | Penyusun |
|---|---|---|---|
| 0.1 | 27-11-2026 | Penyusunan awal dari master prompt | Tim Produk |
| 1.0 | 27-11-2026 | Penambahan konteks AI Studio dan daftar OPEN DECISION | Tim Produk |

---

## 1. Ringkasan Eksekutif

SIPENGUJI adalah aplikasi web mandiri untuk membantu pengelolaan administrasi pengawasan, pelaksanaan pengawasan, monitoring peserta, pencatatan kejadian, dan pelaporan ujian madrasah secara digital. SIPENGUJI **bukan** aplikasi administrasi ujian. Data peserta, pengawas, jadwal, dan denah diperoleh dari dokumen yang diekspor dari aplikasi SAUM yang sudah digunakan madrasah.

Nilai utama aplikasi:
1. Admin tidak perlu menginput data secara manual; cukup mengunggah dokumen hasil ekspor SAUM.
2. Pengawas mendapatkan administrasi ruang yang sudah terisi otomatis.
3. Denah peserta interaktif memudahkan pengawas memantau peserta dan mencatat kejadian per kursi.
4. Admin memperoleh pemantauan terpusat seluruh ruang secara near real-time.

Dokumen ini menjadi sumber kebenaran tunggal (single source of truth) untuk desain, implementasi, pengujian, dan deployment SIPENGUJI di Google AI Studio.

---

## 2. Latar Belakang

Pengawasan ujian madrasah saat ini membutuhkan banyak dokumen cetak: daftar hadir, berita acara, denah, dan catatan kejadian. Data yang sama harus ditulis ulang oleh panitia dan pengawas. Madrasah sudah memiliki SAUM untuk administrasi ujian utama, sehingga kebutuhan SIPENGUJI difokuskan pada tahap pengawasan dan pelaporan, serta pemanfaatan ulang dokumen ekspor SAUM.

---

## 3. Tujuan Proyek

1. Menghilangkan input ulang data peserta, pengawas, dan jadwal yang sudah tersedia di SAUM.
2. Menghasilkan administrasi pengawasan (cover, denah, daftar hadir, berita acara, dan lainnya) secara otomatis.
3. Menyediakan denah peserta interaktif untuk pemantauan dan pencatatan kejadian per kursi.
4. Mencatat peringatan, izin keluar, dan kejadian khusus dengan jejak audit yang lengkap.
5. Menyediakan pelaporan dan verifikasi berkas pengawasan secara digital.
6. Memberikan pemantauan terpusat bagi Admin.

### Indikator keberhasilan (KPI)
- 100% ruang ujian memiliki administrasi digital terbentuk dari impor dokumen.
- Waktu penyiapan administrasi per ruang berkurang signifikan dibanding proses manual (target diukur saat UAT).
- Nol peristiwa data peserta tertukar akibat ekstraksi yang tidak diverifikasi.
- Seluruh berita acara masuk dan diverifikasi sebelum batas waktu yang ditetapkan panitia.

---

## 4. Ruang Lingkup

### 4.1 Dalam lingkup
- Autentikasi dan registrasi akun pengawas.
- Unggah dan ekstraksi dokumen hasil ekspor SAUM (PDF teks, PDF scan, Excel, CSV).
- Validasi, pratinjau, dan koreksi data oleh Admin.
- Generator administrasi otomatis (sebelas jenis dokumen).
- Jadwal pengawasan dengan aktivasi otomatis berbasis waktu server.
- Modul Mengawasi Ujian: denah interaktif, peringatan tiga tahap, izin keluar, timer, dan pengawasan bersama.
- Modul upload berkas pengawas: berita acara dan daftar hadir.
- Dashboard monitoring Admin.
- Notifikasi internal.
- Audit log dan rekapitulasi.

### 4.2 Di luar lingkup (fase ini)
- Administrasi ujian utama (pendaftaran, penjadwalan induk, nilai) — menjadi tugas SAUM.
- Integrasi API langsung ke SAUM. Pertukaran data hanya melalui file ekspor.
- Perubahan pada SAUM.
- Push notification (dapat dikembangkan sebagai fitur lanjutan).
- Sanksi administratif otomatis terhadap peserta.
- Aplikasi native mobile terpisah (aplikasi web responsif saja).

### 4.3 OPEN DECISION
- **OD-01**: Apakah SIPENGUJI perlu API integrasi dengan SAUM di masa depan? Saat ini tidak diasumsikan.

---

## 5. Stakeholder

| Stakeholder | Peran | Kepentingan |
|---|---|---|
| Kepala madrasah / pemilik proyek | Pengambil keputusan | Akuntabilitas, persetujuan produksi |
| Panitia ujian (Admin) | Pengelola utama | Efisiensi administrasi, kontrol pengawasan |
| Pengawas (guru) | Pengguna lapangan | Kemudahan penggunaan saat bertugas |
| Peserta dan orang tua | Pihak terdampak | Keadilan, kerahasiaan data |
| Tim pengembang | Pembangun sistem | Spesifikasi jelas dan terukur |
| Pengelola SAUM | Penyedia dokumen ekspor | Tidak terganggunya SAUM |

---

## 6. Persona Pengguna

**Persona 1 — Admin / Panitia (Pak Hasan, Waka Kurikulum)**
Mengelola banyak ruang dan pengawas sekaligus. Menggunakan laptop di ruang panitia. Membutuhkan proses impor yang cepat dan pemantauan yang jelas.

**Persona 2 — Pengawas (Bu Siti, guru mata pelajaran)**
Bertugas di satu ruang per sesi. Menggunakan ponsel atau tablet di dalam ruang ujian. Membutuhkan tampilan sederhana, tombol besar, dan respons cepat.

**Persona 3 — Pengawas pendamping (Pak Andi)**
Bertugas bersama pengawas utama. Membutuhkan melihat pembaruan yang dilakukan rekannya tanpa input ulang.

---

## 7. Hak Akses

| Fitur | Admin | Pengawas (bertugas) | Pengawas (tidak bertugas) |
|---|---|---|---|
| Kelola kegiatan ujian | Ya | Tidak | Tidak |
| Unggah dan ekstraksi dokumen | Ya | Tidak | Tidak |
| Koreksi hasil ekstraksi | Ya | Tidak | Tidak |
| Kelola akun pengawas | Ya | Tidak | Tidak |
| Lihat jadwal sendiri | Ya | Ya | Ya |
| Masuk Mengawasi Ujian | Ya (monitoring) | Ya, sesuai penugasan | Tidak |
| Denah peserta & peringatan | Lihat | Ubah (sesuai penugasan) | Tidak |
| Izin keluar | Lihat | Catat | Tidak |
| Upload berita acara & daftar hadir | Verifikasi | Ya | Tidak |
| Dashboard monitoring | Ya | Tidak | Tidak |
| Audit log | Lihat | Tidak | Tidak |

Aturan: Pengawas hanya dapat mengakses ruang dan sesi tempat ia ditugaskan. Pemeriksaan dilakukan di server pada setiap permintaan, bukan hanya di tampilan.

---

## 8. Alur Sistem Keseluruhan

1. Admin mengunduh dokumen dari SAUM.
2. Admin mengunggah dokumen ke SIPENGUJI.
3. Sistem mengenali jenis dokumen dan mengekstrak data.
4. Sistem menampilkan pratinjau dan daftar kesalahan/data gagal baca.
5. Admin memeriksa, mengoreksi bila perlu, lalu mengonfirmasi.
6. Data disimpan ke database; sistem membentuk administrasi otomatis.
7. Pengawas mendaftar akun dan terhubung dengan data pengawas dari Admin.
8. Pada waktu mulai, jadwal aktif otomatis; pengawas menekan MULAI PENGAWASAN.
9. Pengawas mencatat peringatan, izin keluar, dan kejadian melalui denah interaktif.
10. Pada akhir sesi, pengawas menyusun berita acara dan daftar hadir, lalu mengunggah dan mengajukan penyelesaian.
11. Admin memverifikasi dan memberi status.
12. Admin memantau dan merekap seluruh kegiatan.

---

## 9. Kebutuhan Fungsional

Setiap kebutuhan diberi kode agar dapat dilacak.

### 9.1 Autentikasi dan Registrasi (FR-AUT)
- **FR-AUT-01** Sistem menyediakan halaman Masuk Pengawas dan Masuk Admin.
- **FR-AUT-02** Pengawas membuat akun dengan memilih nama dari daftar pengawas yang diimpor Admin.
- **FR-AUT-03** Sistem menolak pembuatan akun jika identitas sudah memiliki akun.
- **FR-AUT-04** Verifikasi identitas dilakukan dengan mekanisme yang ditentukan (lihat OD-02).
- **FR-AUT-05** Pengawas mengisi username dan password. Password disimpan dalam bentuk hash.
- **FR-AUT-06** Pengawas melengkapi identitas: nama lengkap, NIP/NUPTK (jika ada), nomor identitas (jika diperlukan), tempat dan tanggal lahir, alamat, nomor WhatsApp, foto profil, dan tanda tangan digital.
- **FR-AUT-07** Sistem mengunci sesi setelah tidak ada aktivitas sesuai kebijakan (lihat OD-03).
- **FR-AUT-08** Lupa password dilakukan melalui Admin atau mekanisme yang ditetapkan (OD-02).

### 9.2 Profil (FR-PRF)
- **FR-PRF-01** Pengawas dapat melihat dan memperbarui data profil yang diizinkan.
- **FR-PRF-02** Data yang berasal dari impor Admin (nama, NIP) tidak dapat diubah pengawas; perubahan diajukan ke Admin.
- **FR-PRF-03** Perubahan tanda tangan dan foto tercatat di audit log.

### 9.3 Impor dan Ekstraksi Dokumen (FR-IMP)
- **FR-IMP-01** Admin dapat mengunggah dokumen berformat PDF (teks atau scan), XLSX, dan CSV.
- **FR-IMP-02** Sistem mengklasifikasikan dokumen ke salah satu jenis berikut: data peserta, data pengawas, jadwal pengawasan, jadwal ujian, pembagian ruang, denah peserta, daftar hadir peserta, denah lingkungan ujian, atau dokumen pendukung lainnya.
- **FR-IMP-03** Jika klasifikasi otomatis tidak yakin, sistem meminta Admin memilih jenis dokumen.
- **FR-IMP-04** Sistem mengekstrak data ke tabel pratinjau yang dapat diperiksa.
- **FR-IMP-05** Setiap baris atau field yang tidak terbaca ditandai dan tidak diisi dengan tebakan.
- **FR-IMP-06** Sistem mendeteksi duplikasi (misalnya NISN ganda, nomor peserta ganda, atau jadwal yang bertabrakan).
- **FR-IMP-07** Admin dapat mengoreksi setiap field sebelum konfirmasi. Setiap koreksi tercatat.
- **FR-IMP-08** Data baru hanya tersimpan setelah Admin menekan KONFIRMASI SIMPAN.
- **FR-IMP-09** File sumber disimpan sebagai arsip dan tidak dapat diubah.
- **FR-IMP-10** Impor ulang dokumen yang sama harus memperbarui data secara terkendali (lihat BR-07).
- **FR-IMP-11** Pemrosesan dokumen besar berjalan asinkron dengan indikator kemajuan.

### 9.4 Generator Administrasi (FR-GEN)
- **FR-GEN-01** Sistem menghasilkan dokumen berikut dari data yang sudah dikonfirmasi: (1) cover administrasi pengawasan, (2) denah lingkungan ujian, (3) denah peserta, (4) jadwal ujian, (5) tata tertib peserta, (6) tata tertib pengawas, (7) daftar hadir peserta, (8) daftar hadir pengawas, (9) berita acara, (10) formulir catatan kejadian khusus, (11) dokumen serah terima berkas ujian.
- **FR-GEN-02** Setiap dokumen dapat ditampilkan, dicetak, dan diunduh dalam format PDF.
- **FR-GEN-03** Dokumen yang dihasilkan selalu mengambil data terbaru. Jika data berubah, dokumen ditandai perlu dibuat ulang.
- **FR-GEN-04** Dokumen hasil generator disimpan dengan versi dan tanggal.

### 9.5 Jadwal Pengawasan (FR-JDW)
- **FR-JDW-01** Pengawas melihat seluruh jadwal pengawasannya: hari, tanggal, jam mulai, jam selesai, sesi, mata pelajaran, ruang, rekan pengawas, dan status.
- **FR-JDW-02** Status jadwal: Akan datang, Aktif, Selesai, Dibatalkan.
- **FR-JDW-03** Jadwal menjadi Aktif otomatis ketika waktu mulai server tercapai (zona WIB).
- **FR-JDW-04** Jadwal menjadi Selesai otomatis ketika waktu selesai server tercapai.
- **FR-JDW-05** Pengawas tidak dapat mengubah jadwal atau status jadwal.
- **FR-JDW-06** Perubahan jadwal oleh Admin memicu notifikasi kepada pengawas terdampak.

### 9.6 Dashboard Pengawas (FR-DSB)
- **FR-DSB-01** Menampilkan identitas dan foto profil pengawas.
- **FR-DSB-02** Menampilkan jumlah jadwal, jadwal berikutnya, jadwal aktif, riwayat pengawasan, status laporan, dan notifikasi panitia.

### 9.7 Mengawasi Ujian (FR-MGU)
Halaman ini dibuka dengan tombol MULAI PENGAWASAN ketika jadwal berstatus Aktif.

**Administrasi ruang (FR-MGU-A)**
- **FR-MGU-A-01** Halaman menampilkan dokumen: cover ruang dan sesi, denah lingkungan, denah peserta, jadwal ujian, tata tertib peserta, tata tertib pengawas, daftar hadir peserta, daftar hadir pengawas, berita acara, dan catatan kejadian khusus.
- **FR-MGU-A-02** Seluruh data terhubung dengan ruang, tanggal, sesi, dan jadwal yang sedang berjalan.

**Denah peserta interaktif (FR-MGU-B)**
- **FR-MGU-B-01** Denah menggambarkan susunan kursi sesuai layout yang diimpor Admin (baris, kolom, dan posisi).
- **FR-MGU-B-02** Setiap kursi menampilkan nomor kursi dan nama peserta.
- **FR-MGU-B-03** Mengklik kursi membuka panel detail: nomor peserta, NISN/NIS, kelas, status kehadiran, status peringatan, dan riwayat kejadian.
- **FR-MGU-B-04** Denah dapat diperbesar dan diperkecil (zoom) serta digeser (pan).
- **FR-MGU-B-05** Warna kursi mencerminkan status: normal (putih/netral), peringatan 1 (hijau), peringatan 2 (kuning), peringatan 3 (merah), izin keluar (abu-abu).
- **FR-MGU-B-06** Kursi peserta yang belum memiliki status hadir ditandai secara visual dan dapat dicatat hadir.

**Sistem peringatan (FR-MGU-C)**
- **FR-MGU-C-01** Pengawas memilih peserta lalu menekan tombol Peringatan 1, 2, atau 3 sesuai tingkatnya.
- **FR-MGU-C-02** Sistem mewajibkan alasan. Tombol simpan nonaktif sampai alasan diisi.
- **FR-MGU-C-03** Setiap peringatan menyimpan identitas pengawas, waktu server, alasan, dan tingkat peringatan.
- **FR-MGU-C-04** Peringatan 1 mengubah kursi menjadi hijau; Peringatan 2 menjadi kuning; Peringatan 3 menjadi merah.
- **FR-MGU-C-05** Peringatan 3 membuat laporan otomatis kepada panitia (Admin).
- **FR-MGU-C-06** Sistem tidak mengeluarkan peserta secara otomatis. Keputusan tindak lanjut ada pada panitia.
- **FR-MGU-C-07** Peringatan tidak dapat dihapus. Koreksi dilakukan dengan entri koreksi yang tercatat (lihat BR-12).

**Izin keluar (FR-MGU-D)**
- **FR-MGU-D-01** Pengawas memilih kursi peserta lalu IZIN KELUAR.
- **FR-MGU-D-02** Alasan dipilih dari daftar atau diisi bebas.
- **FR-MGU-D-03** Sistem mencatat waktu keluar dan mengubah kursi menjadi abu-abu.
- **FR-MGU-D-04** Pengawas menekan KEMBALI; sistem mencatat waktu kembali dan menghitung durasi.
- **FR-MGU-D-05** Satu peserta tidak boleh memiliki dua izin keluar aktif secara bersamaan.
- **FR-MGU-D-06** Riwayat izin dapat diperiksa Admin. Izin tidak menghapus riwayat peringatan.

**Timer dan jam (FR-MGU-E)**
- **FR-MGU-E-01** Jam digital real-time (zona WIB).
- **FR-MGU-E-02** Timer ujian dan hitung mundur sisa waktu.
- **FR-MGU-E-03** Jam mulai dan jam selesai aktual tercatat dari waktu server.
- **FR-MGU-E-04** Indikator ujian berlangsung.
- **FR-MGU-E-05** Pemberitahuan pada 15 menit (nilai dapat diatur, lihat OD-05) sebelum ujian selesai.

**Pengawasan bersama (FR-MGU-F)**
- **FR-MGU-F-01** Semua pengawas yang bertugas pada ruang dan sesi yang sama melihat data yang sama.
- **FR-MGU-F-02** Perubahan oleh satu pengawas tampil di layar pengawas lain secara real-time atau mendekati real-time.
- **FR-MGU-F-03** Setiap tindakan mencatat pelaku, waktu, dan jenis tindakan.
- **FR-MGU-F-04** Konflik pembaruan bersamaan ditangani dengan aturan yang ditetapkan (lihat BR-10).

### 9.8 Upload Berkas Pengawas (FR-UPL)
- **FR-UPL-01** Menu Upload Berkas berisi Berita Acara dan Daftar Hadir.
- **FR-UPL-02** Berita Acara berisi: identitas madrasah, hari dan tanggal, ruang dan sesi, mata pelajaran, jumlah terdaftar, jumlah hadir, jumlah tidak hadir, kondisi pelaksanaan, catatan kejadian, nama pengawas, dan tanda tangan digital.
- **FR-UPL-03** Jumlah hadir dan tidak hadir dihitung otomatis dari data kehadiran peserta; pengawas tidak dapat mengubahnya secara manual tanpa keterangan.
- **FR-UPL-04** Daftar Hadir: pengawas dapat mengunduh format, mencetak, mengunggah dokumen bertanda tangan, mengunggah hasil scan atau foto, melihat pratinjau, dan mengirim ke Admin.
- **FR-UPL-05** Status dokumen: Belum dikerjakan, Belum dikirim, Menunggu verifikasi, Perlu perbaikan, Terverifikasi.
- **FR-UPL-06** Admin dapat meminta perbaikan dengan catatan; pengawas mengunggah versi baru.

### 9.9 Penyelesaian Pengawasan (FR-SLS)
- **FR-SLS-01** Pengawas mengajukan penyelesaian setelah berita acara, daftar hadir, dan catatan kejadian lengkap.
- **FR-SLS-02** Sistem memeriksa kelengkapan sebelum pengajuan dapat dikirim. Dokumen yang kurang ditampilkan dalam daftar.
- **FR-SLS-03** Status penyelesaian: Sedang berlangsung, Menunggu pengiriman laporan, Menunggu verifikasi, Perlu perbaikan, Terverifikasi.

### 9.10 Monitoring Admin (FR-MON)
- **FR-MON-01** Dashboard menampilkan: jumlah pengawas, ruang, sesi; pengawas hadir dan belum hadir; ruang yang berlangsung; peserta hadir dan tidak hadir; jumlah izin keluar; jumlah peringatan; peserta dengan peringatan 3; berita acara dan daftar hadir yang sudah masuk; laporan yang belum diverifikasi.
- **FR-MON-02** Admin dapat membuka setiap ruang untuk melihat denah, status kursi, identitas pengawas, catatan kejadian, riwayat peringatan, status izin keluar, dan kelengkapan administrasi.
- **FR-MON-03** Admin memverifikasi laporan dan memberikan status: Perlu perbaikan atau Terverifikasi, disertai catatan.
- **FR-MON-04** Admin dapat mengelola akun pengawas (aktifkan, nonaktifkan, dan penugasan ulang) dengan audit log.
- **FR-MON-05** Admin dapat menghasilkan laporan rekapitulasi dalam PDF dan format tabel yang dapat diunduh.

### 9.11 Notifikasi (FR-NOT)
- **FR-NOT-01** Sistem menyediakan notifikasi internal (di dalam aplikasi) untuk: jadwal akan dimulai, jadwal aktif, perubahan jadwal, peringatan 3, pengawas belum hadir, dokumen belum dikirim, dokumen perlu diperbaiki, dokumen terverifikasi, dan pengumuman panitia.
- **FR-NOT-02** Notifikasi memiliki status dibaca dan belum dibaca.
- **FR-NOT-03** Push notification berada di luar fase awal (lihat OD-06).

---

## 10. Kebutuhan Nonfungsional

| Kode | Kategori | Kebutuhan |
|---|---|---|
| NFR-01 | Kinerja | Halaman utama memuat dalam 3 detik pada jaringan 4G standar. |
| NFR-02 | Kinerja | Pembaruan denah antar-pengawas tampil dalam 3 detik. |
| NFR-03 | Kinerja | Ekstraksi dokumen 100 halaman diselesaikan dengan indikator kemajuan; target waktu ditetapkan pada fase 2 (OD-04). |
| NFR-04 | Ketersediaan | Modul Mengawasi Ujian tersedia selama jam ujian; target ketersediaan 99% pada jam ujian. |
| NFR-05 | Responsif | Aplikasi berfungsi pada ponsel (≥360 px), tablet, dan desktop. |
| NFR-06 | Keamanan | Seluruh komunikasi menggunakan HTTPS. |
| NFR-07 | Keamanan | Password disimpan dalam bentuk hash yang kuat (bcrypt, Argon2, atau setara). |
| NFR-08 | Integritas | Waktu kejadian diambil dari waktu server, bukan dari perangkat. |
| NFR-09 | Audit | Seluruh tindakan kritis tercatat dan tidak dapat dihapus oleh pengguna. |
| NFR-10 | Backup | Backup database harian dengan retensi minimal 30 hari (OD-07). |
| NFR-11 | Privasi | Data peserta hanya dapat diakses sesuai hak akses; data tidak digunakan untuk tujuan lain. |
| NFR-12 | Aksesibilitas | Kontras teks memenuhi WCAG AA; tombol minimal 44×44 px pada perangkat sentuh. |
| NFR-13 | Bahasa | Antarmuka dan dokumen menggunakan Bahasa Indonesia. |
| NFR-14 | Zona waktu | Seluruh waktu tampil dan tersimpan dalam WIB (UTC+07:00). |
| NFR-15 | Pemeliharaan | Kode terstruktur per modul agar mudah diuji dan dipelihara. |

---

## 11. Spesifikasi Setiap Modul (Ringkasan Perilaku)

### 11.1 Modul Autentikasi
- **Perilaku normal**: Pengawas memilih nama, memverifikasi identitas, membuat kredensial, melengkapi profil, dan akun terhubung otomatis.
- **Kondisi gagal**: Nama sudah terdaftar → tampilkan pesan "Akun untuk identitas ini sudah ada" dan tawarkan masuk. Verifikasi gagal berkali-kali → kunci sementara dan arahkan ke Admin.

### 11.2 Modul Impor
- **Perilaku normal**: Unggah → klasifikasi → ekstraksi → pratinjau → koreksi → konfirmasi → simpan → tampil di generator.
- **Kondisi gagal**: File rusak atau terproteksi → tolak dengan pesan jelas. Sebagian baris gagal → simpan baris valid hanya setelah Admin menyetujui, baris gagal ditandai. Format tidak dikenali → minta Admin memilih jenis dokumen.

### 11.3 Modul Jadwal
- **Perilaku normal**: Status berubah otomatis mengikuti waktu server.
- **Kondisi gagal**: Perangkat pengawas salah jam → sistem tetap memakai waktu server. Koneksi terputus saat waktu mulai → status diperbarui saat koneksi kembali.

### 11.4 Modul Mengawasi Ujian
- **Perilaku normal**: Klik kursi → aksi → alasan → simpan → kursi berubah warna dan terlihat oleh pengawas lain.
- **Kondisi gagal**: Koneksi terputus → aksi disimpan sementara di perangkat dengan penanda "menunggu sinkronisasi" dan tidak dianggap tersimpan sampai server mengonfirmasi (lihat BR-11). Dua pengawas mengubah kursi sama → lihat BR-10.

### 11.5 Modul Upload Berkas
- **Perilaku normal**: Isi formulir → unggah → kirim → status menunggu verifikasi.
- **Kondisi gagal**: Berkas melebihi batas ukuran → tolak dengan batas yang jelas. Tanda tangan kosong → formulir tidak dapat dikirim.

### 11.6 Modul Monitoring
- **Perilaku normal**: Angka dan status diperbarui otomatis dan dapat ditelusuri ke data sumber.
- **Kondisi gagal**: Data belum tersinkron → tandai sebagai "belum lengkap" dan jangan tampilkan sebagai angka final.

---

## 12. User Stories

| ID | Sebagai | Saya ingin | Agar | Prioritas |
|---|---|---|---|---|
| US-01 | Admin | mengunggah dokumen ekspor SAUM | data tidak diinput ulang | Tinggi |
| US-02 | Admin | meninjau hasil ekstraksi sebelum disimpan | data yang salah tidak masuk | Tinggi |
| US-03 | Admin | menghasilkan 11 dokumen administrasi otomatis | menghemat waktu persiapan | Tinggi |
| US-04 | Pengawas | membuat akun dari daftar nama panitia | identitas saya terhubung dengan benar | Tinggi |
| US-05 | Pengawas | melihat jadwal yang otomatis aktif | saya tahu kapan harus masuk ruang | Tinggi |
| US-06 | Pengawas | melihat denah kursi dan klik peserta | saya dapat memantau dengan cepat | Tinggi |
| US-07 | Pengawas | memberi peringatan bertingkat dengan alasan | tindakan tercatat dan dapat dipertanggungjawabkan | Tinggi |
| US-08 | Pengawas | mencatat izin keluar dan kembali | durasi izin tercatat otomatis | Tinggi |
| US-09 | Pengawas | melihat catatan rekan pengawas secara langsung | kami tidak bekerja dengan data berbeda | Tinggi |
| US-10 | Pengawas | menyusun berita acara dengan data terisi otomatis | pelaporan lebih cepat | Sedang |
| US-11 | Pengawas | mengunggah daftar hadir bertanda tangan | arsip lengkap | Sedang |
| US-12 | Admin | memantau seluruh ruang dari satu dashboard | saya tahu kondisi ujian secara real-time | Tinggi |
| US-13 | Admin | menerima laporan peringatan 3 | keputusan tindak lanjut diambil panitia | Tinggi |
| US-14 | Admin | memverifikasi berita acara | laporan memenuhi standar | Sedang |
| US-15 | Admin | melihat audit log | setiap perubahan dapat dilacak | Tinggi |
| US-16 | Pengawas | menerima notifikasi perubahan jadwal | saya tidak terlewat tugas | Sedang |

---

## 13. Business Rules

| Kode | Aturan |
|---|---|
| BR-01 | Satu identitas pengawas hanya boleh memiliki satu akun. |
| BR-02 | Akun pengawas hanya dapat dibuat dari daftar pengawas yang diimpor Admin. |
| BR-03 | Pengawas hanya dapat mengakses ruang dan sesi tempat ia ditugaskan. |
| BR-04 | Status jadwal ditentukan oleh waktu server (WIB) dan tidak dapat diubah pengguna. |
| BR-05 | Setiap peringatan wajib memiliki alasan. |
| BR-06 | Peringatan 3 otomatis membuat laporan kepada panitia. Sistem tidak mengeluarkan peserta. |
| BR-07 | Impor ulang dokumen sejenis untuk ujian yang sama menampilkan perbandingan perubahan; data berubah hanya setelah Admin mengonfirmasi. |
| BR-08 | Data yang tidak terbaca tidak boleh diisi dengan tebakan. |
| BR-09 | Dokumen sumber tidak dapat diubah atau dihapus setelah diarsipkan (kecuali oleh proses retensi yang disetujui). |
| BR-10 | Konflik pembaruan bersamaan: tindakan yang lebih dulu diterima server berlaku; tindakan kedua ditolak dengan pemberitahuan dan pengawas diminta meninjau ulang. Peringatan tidak pernah ditimpa, melainkan ditambahkan. |
| BR-11 | Data yang belum dikonfirmasi server dianggap belum tersimpan. |
| BR-12 | Koreksi riwayat dilakukan dengan entri koreksi baru yang mencatat nilai lama, nilai baru, alasan, dan pelaku. |
| BR-13 | Izin keluar tidak menghapus atau mengubah riwayat peringatan. |
| BR-14 | Satu peserta tidak boleh memiliki dua izin keluar aktif. |
| BR-15 | Berita acara hanya dapat diajukan jika daftar hadir dan jumlah peserta sudah sesuai dengan data kursi. |
| BR-16 | Laporan yang sudah Terverifikasi tidak dapat diubah pengawas; perubahan memerlukan pengajuan baru dari Admin. |
| BR-17 | Audit log bersifat append-only. |
| BR-18 | Pengawas yang dinonaktifkan Admin kehilangan akses ke sesi berikutnya, tetapi riwayat tindakannya tetap tersimpan. |

---

## 14. User Flow

### 14.1 Registrasi Pengawas
Masuk Pengawas → Buat Akun → pilih nama → verifikasi → buat username dan password → lengkapi profil → unggah foto → buat tanda tangan digital → akun terhubung → Dashboard.

Percabangan: nama tidak ditemukan → hubungi Admin. Akun sudah ada → arahkan ke Masuk.

### 14.2 Import Dokumen Admin
Dashboard Admin → Impor Dokumen → unggah file → sistem mengenali jenis → ekstraksi → pratinjau → koreksi → konfirmasi → data tersimpan → dokumen administrasi tersedia.

Percabangan: klasifikasi tidak yakin → Admin memilih jenis. Ekstraksi gagal → tampilkan daftar gagal dan opsi unggah ulang.

### 14.3 Pengawasan Ujian
Dashboard Pengawas → Jadwal (status Aktif) → MULAI PENGAWASAN → Mengawasi Ujian → (klik kursi → peringatan / izin keluar / detail) → timer berjalan → akhir sesi → Upload Berkas.

Percabangan: jadwal belum aktif → tombol nonaktif dengan keterangan waktu mulai. Koneksi terputus → mode menunggu sinkronisasi.

### 14.4 Penyelesaian
Mengawasi Ujian selesai → Upload Berkas (berita acara, daftar hadir) → Ajukan Penyelesaian → Admin memeriksa → Terverifikasi atau Perlu Perbaikan.

### 14.5 Peringatan 3
Pengawas memberi peringatan 3 → kursi merah → laporan terkirim ke Admin → Admin membuka riwayat → memutuskan tindak lanjut di luar sistem → status laporan dicatat.

---

## 15. Use Case

| ID | Use case | Aktor | Pra-kondisi | Pasca-kondisi |
|---|---|---|---|---|
| UC-01 | Registrasi pengawas | Pengawas | Nama ada di data Admin | Akun aktif dan terhubung |
| UC-02 | Impor dokumen SAUM | Admin | File ekspor tersedia | Data tersimpan setelah konfirmasi |
| UC-03 | Generate administrasi | Admin | Data terkonfirmasi | Dokumen PDF tersedia |
| UC-04 | Aktivasi jadwal | Sistem | Waktu mulai tercapai | Jadwal Aktif |
| UC-05 | Beri peringatan | Pengawas | Ruang bertugas, jadwal aktif | Peringatan tersimpan, kursi berubah warna |
| UC-06 | Catat izin keluar | Pengawas | Peserta di kursi | Izin aktif, lalu selesai dengan durasi |
| UC-07 | Pengawasan bersama | Pengawas | Penugasan sama | Pembaruan terlihat semua pengawas |
| UC-08 | Upload berita acara | Pengawas | Sesi selesai | Dokumen menunggu verifikasi |
| UC-09 | Verifikasi laporan | Admin | Dokumen terkirim | Status Terverifikasi/Perlu Perbaikan |
| UC-10 | Pantau ruang | Admin | Sesi berlangsung | Status ruang tampil real-time |
| UC-11 | Tinjau peringatan 3 | Admin | Laporan peringatan 3 ada | Catatan tindak lanjut tersimpan |

---

## 16. Arsitektur Sistem

### 16.1 Gambaran Umum
Arsitektur terdiri dari:
- **Frontend**: aplikasi web responsif (React, TypeScript, Tailwind CSS).
- **Backend**: layanan API untuk autentikasi, otorisasi, logika bisnis, dan pemrosesan dokumen.
- **Database relasional/dokumen**: penyimpanan data terstruktur dan audit log.
- **Penyimpanan berkas**: arsip dokumen sumber dan dokumen hasil generator.
- **Layanan ekstraksi**: pembacaan PDF teks, PDF scan (OCR), Excel, dan CSV.
- **Layanan realtime**: sinkronisasi antar-perangkat pengawas.
- **Deployment**: frontend dan backend di lingkungan yang didukung AI Studio atau platform lain yang disetujui (OD-08).

### 16.2 Alasan Pemilihan Platform (Google AI Studio)
- AI Studio menyediakan lingkungan pembangunan aplikasi web berbasis React dan TypeScript, sesuai kebutuhan antarmuka.
- Kemampuan model multimodal dapat dimanfaatkan untuk membaca PDF dan gambar hasil scan. Penggunaannya tetap tunduk pada aturan BR-08 (tidak boleh mengarang data) dan wajib diverifikasi Admin.
- Keputusan pemilihan database, autentikasi, dan layanan realtime masih terbuka (lihat OD-09).

### 16.3 Prinsip Arsitektur
- Validasi dilakukan di server, bukan hanya di antarmuka.
- Waktu kritis (aktivasi jadwal, waktu peringatan) berasal dari server.
- Setiap modul memiliki batas tanggung jawab yang jelas.
- SAUM tidak diubah; pertukaran data hanya melalui file ekspor.

### 16.4 Pemisahan Repositori
SAUM dan SIPENGUJI memiliki repositori dan deployment masing-masing.

---

## 17. Struktur Database

Struktur berikut bersifat konseptual. Tipe data final ditentukan setelah pemilihan database (OD-09).

### 17.1 Entitas

| Entitas | Tujuan | Field utama | PK | FK / Relasi | Aturan validasi | Hak akses |
|---|---|---|---|---|---|---|
| users | Akun login | id, username, password_hash, role, status, created_at | id | 1:1 supervisors (pengawas) | username unik; role ∈ {admin, supervisor} | Admin kelola; pengguna lihat data sendiri |
| supervisors | Data pengawas | id, user_id, nama_lengkap, nip_nuptk, nomor_identitas, tempat_lahir, tgl_lahir, alamat, whatsapp, foto_url, ttd_url, status | id | user_id → users (nullable sampai registrasi) | NIP unik jika ada; satu user satu supervisor | Admin penuh; pengawas lihat diri sendiri |
| exams | Kegiatan ujian | id, nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status | id | — | tanggal_selesai ≥ tanggal_mulai | Admin |
| exam_sessions | Sesi ujian | id, exam_id, nama_sesi, tanggal, jam_mulai, jam_selesai | id | exam_id → exams | jam_selesai > jam_mulai; tidak bertabrakan pada ruang yang sama | Admin |
| subjects | Mata pelajaran | id, kode, nama | id | — | kode unik | Admin |
| rooms | Ruang ujian | id, kode, nama, kapasitas, layout_json | id | — | kapasitas > 0 | Admin |
| students | Data peserta | id, exam_id, nomor_peserta, nisn, nis, nama, kelas | id | exam_id → exams | nomor_peserta unik per ujian; NISN wajib jika tersedia | Admin penuh; pengawas lihat peserta ruangnya |
| seats | Kursi di denah | id, room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id | id | room_id → rooms; student_id → students | kode unik per ruang; satu peserta satu kursi per sesi | Admin atur; pengawas lihat ruangnya |
| exam_schedules | Jadwal ujian | id, exam_session_id, subject_id, room_id, tanggal, jam_mulai, jam_selesai | id | session, subject, room | tidak bertabrakan | Admin |
| supervision_assignments | Penugasan pengawas | id, supervisor_id, room_id, exam_session_id, peran (utama/pendamping), status_jadwal | id | supervisor, room, session | satu pengawas tidak ganda pada jam sama | Admin atur |
| documents | Berkas sumber dan hasil | id, jenis, nama_file, path, sha256, uploaded_by, version, status_verifikasi | id | uploaded_by → users | file sumber tidak dapat diubah; sha256 wajib | Admin; pengawas sesuai penugasan |
| attendance | Kehadiran peserta | id, student_id, exam_schedule_id, status, dicatat_oleh, waktu | id | student, schedule, users | status ∈ {hadir, tidak hadir, belum} | Pengawas bertugas |
| supervisor_attendance | Kehadiran pengawas | id, assignment_id, waktu_hadir, status | id | assignment | satu baris per penugasan per sesi | Admin lihat; pengawas catat diri |
| warnings | Peringatan | id, student_id, exam_schedule_id, tingkat (1–3), alasan, dicatat_oleh, waktu_server | id | student, schedule, users | alasan wajib; tingkat ∈ {1,2,3}; tidak dapat dihapus | Pengawas bertugas buat; Admin lihat |
| exit_permissions | Izin keluar | id, student_id, exam_schedule_id, alasan, waktu_keluar, waktu_kembali, durasi_detik, dicatat_oleh | id | student, schedule, users | satu izin aktif per peserta (BR-14) | Pengawas bertugas; Admin lihat |
| incident_reports | Catatan kejadian | id, exam_schedule_id, deskripsi, waktu, dicatat_oleh | id | schedule, users | deskripsi wajib | Pengawas bertugas; Admin lihat |
| supervision_reports | Berita acara dan laporan | id, exam_schedule_id, supervisor_id, jenis, data_json, status, dikirim_pada | id | schedule, supervisors | data hadir cocok dengan attendance (BR-15) | Pengawas buat; Admin verifikasi |
| report_verifications | Riwayat verifikasi | id, report_id, admin_id, status, catatan, waktu | id | supervision_reports, users | status wajib; catatan wajib jika perlu perbaikan | Admin |
| notifications | Notifikasi internal | id, user_id, judul, isi, dibaca, dibuat_pada | id | users | — | Pemilik notifikasi |
| audit_logs | Jejak audit | id, user_id, aksi, entitas, entitas_id, nilai_lama, nilai_baru, waktu_server, ip | id | users | append-only (BR-17) | Admin lihat; tidak ada hapus/ubah |

### 17.2 Catatan Pengembangan Database
- Setiap tabel data sensitif memiliki kolom waktu server (`created_at`, `waktu_server`).
- Penghapusan data utama menggunakan penandaan nonaktif, bukan hapus fisik.
- Field tanda tangan dan foto disimpan sebagai berkas dengan referensi URL.

---

## 18. Integrasi dan Pengolahan Dokumen

### 18.1 Sumber Data
Seluruh data masuk melalui dokumen ekspor SAUM. Tidak ada integrasi API langsung pada fase ini (OD-01).

### 18.2 Pipeline Pengolahan
1. **Penerimaan**: validasi tipe dan ukuran file; hitung sha256; simpan sebagai sumber.
2. **Klasifikasi**: deteksi jenis berdasarkan struktur (header kolom, judul, pola teks).
3. **Ekstraksi**: PDF teks langsung; PDF scan melalui OCR; Excel dan CSV dibaca per baris.
4. **Normalisasi**: format tanggal (WIB), format nama, format NISN.
5. **Validasi**: field wajib, format, duplikasi, konsistensi antar-dokumen (misalnya nomor peserta di denah harus ada di data peserta).
6. **Pratinjau**: tampilkan hasil dengan penanda baris gagal dan sumber asal.
7. **Koreksi dan konfirmasi**: Admin memperbaiki dan mengonfirmasi.
8. **Penyimpanan**: transaksi atomik; jika gagal, tidak ada data parsial yang tersimpan.

### 18.3 Aturan Ekstraksi
- Tidak boleh mengarang data yang tidak terbaca (BR-08).
- Setiap nilai hasil OCR memiliki tingkat keyakinan; nilai rendah wajib diperiksa Admin.
- Denah dibaca sebagai struktur kursi (baris, kolom, posisi). Jika layout tidak dapat dibaca, Admin dapat menyusun layout manual dari data kolom/baris.

### 18.4 Keamanan Dokumen
- Dokumen peserta hanya dapat diunduh oleh pihak berwenang.
- Tautan unduhan bersifat sementara.
- Dokumen tidak ditampilkan di tempat publik.

### 18.5 Penanganan Kesalahan Pengolahan
- File gagal diproses: status "Gagal", pesan jelas, dapat diunggah ulang.
- Pemrosesan terhenti: dapat dilanjutkan tanpa mengulang dari awal.

---

## 19. Keamanan

| Aspek | Kebutuhan |
|---|---|
| Autentikasi | Password hash kuat; kebijakan panjang minimum (OD-03); rate-limit login. |
| Otorisasi | Role-based access control dan pemeriksaan kepemilikan penugasan di setiap endpoint. |
| Validasi | Seluruh validasi dilakukan di server. |
| Waktu | Aktivasi jadwal dan timestamp peringatan dari waktu server. |
| Audit | Semua tindakan kritis tercatat; audit log tidak dapat dihapus. |
| Duplikasi | Batasan unik di database dan idempotency key untuk aksi peringatan/izin. |
| Sinkronisasi | Penanganan konflik sesuai BR-10; data antrean lokal tidak dianggap tersimpan (BR-11). |
| Dokumen | Arsip sumber tidak dapat diubah (sha256); unduhan melalui tautan sementara. |
| Transport | HTTPS wajib. |
| Backup | Backup harian; uji pemulihan minimal sekali per fase. |
| Privasi | Data peserta tidak dibagikan ke pihak ketiga tanpa keputusan pemilik proyek (OD-10). |
| Akses tidak sah | Pencatatan percobaan akses gagal; pembatasan jumlah percobaan. |

---

## 20. Pelaporan

- **Laporan pengawasan per ruang**: kehadiran, peringatan, izin keluar, kejadian khusus.
- **Laporan pengawasan per kegiatan**: rekap seluruh ruang dan sesi.
- **Laporan kepatuhan pelaporan**: pengawas yang belum mengirim atau dokumen yang perlu perbaikan.
- **Laporan peringatan 3**: daftar peserta dengan peringatan tingkat 3.
- **Ekspor**: PDF dan tabel (CSV/XLSX) untuk arsip.

Setiap laporan menampilkan waktu pembuatan, nama pembuat, dan versi data.

---

## 21. UI/UX dan Navigasi

### 21.1 Prinsip Desain
- Sederhana dan jelas untuk penggunaan cepat di dalam ruang ujian.
- Tombol besar untuk perangkat sentuh.
- Status selalu terlihat (warna dan ikon, tidak hanya warna).
- Setiap aksi destruktif atau sensitif memerlukan konfirmasi.

### 21.2 Navigasi Pengawas
Menu bawah (mobile) atau sisi (desktop): Dashboard, Jadwal, Pengawasan Ujian, Upload Berkas, Riwayat Pengawasan, Profil dan Pengaturan.

### 21.3 Navigasi Admin
Dashboard Monitoring, Kegiatan Ujian, Impor Dokumen, Ruang dan Denah, Pengawas, Pengawasan (monitoring ruang), Laporan dan Verifikasi, Notifikasi, Audit Log, Pengaturan.

### 21.4 Wireframe Deskriptif

**Halaman Mengawasi Ujian (perangkat sentuh)**
- Bagian atas: jam digital WIB, timer sisa waktu, nama ruang dan sesi, indikator "ujian berlangsung".
- Bagian tengah: denah kursi dengan zoom dan geser; setiap kursi menampilkan nomor dan nama singkat.
- Panel bawah (saat kursi dipilih): detail peserta, tombol Peringatan 1, 2, 3, Izin Keluar/Kembali, dan Riwayat.
- Tombol melayang atau bagian bawah: Catatan Kejadian.

**Halaman Impor Dokumen (Admin)**
- Area unggah.
- Setelah unggah: jenis dokumen terdeteksi (dengan opsi ubah), tabel pratinjau, penanda baris gagal, dan tombol KONFIRMASI SIMPAN.

**Dashboard Monitoring (Admin)**
- Kartu ringkas: pengawas hadir/belum, ruang berlangsung, peserta hadir/tidak hadir, izin keluar, peringatan, peringatan 3, laporan belum diverifikasi.
- Daftar ruang dengan status; klik untuk membuka detail ruang.

### 21.5 Sistem Warna Status Kursi
| Status | Warna | Indikator tambahan |
|---|---|---|
| Normal | Netral | — |
| Peringatan 1 | Hijau | Ikon 1 |
| Peringatan 2 | Kuning | Ikon 2 |
| Peringatan 3 | Merah | Ikon 3 dan notifikasi |
| Izin keluar | Abu-abu | Ikon jam |

---

## 22. Tahapan Pengembangan

| Fase | Cakupan | Keluaran |
|---|---|---|
| FASE 1 — Fondasi | Autentikasi, registrasi pengawas, profil, database, impor dasar | Akun dapat dibuat; data pengawas dan peserta dapat diimpor |
| FASE 2 — Administrasi Otomatis | Ekstraksi PDF/OCR, validasi, generator dokumen, denah dan jadwal | 11 dokumen administrasi dapat dihasilkan |
| FASE 3 — Pengawasan Interaktif | Aktivasi jadwal, denah interaktif, peringatan, izin keluar, timer, pengawasan bersama | Modul Mengawasi Ujian siap uji lapangan |
| FASE 4 — Pelaporan | Berita acara, daftar hadir, upload, verifikasi Admin | Alur laporan end-to-end |
| FASE 5 — Monitoring | Dashboard pusat, monitoring ruang, notifikasi, rekapitulasi | Pemantauan Admin lengkap |
| FASE 6 — Pengujian dan Deployment | Uji fungsional, keamanan, integrasi, sinkronisasi, UAT, persetujuan Admin, produksi | Sistem siap digunakan |

Setiap fase diakhiri dengan review oleh Admin. Fase berikutnya tidak dimulai sebelum persetujuan.

### 22.1 Prioritas Pengembangan (MoSCoW)
- **Must have**: autentikasi, impor, generator, jadwal otomatis, denah, peringatan, izin keluar, berita acara, dashboard Admin, audit log.
- **Should have**: pengawasan bersama real-time, notifikasi lengkap, rekapitulasi.
- **Could have**: push notification, pengaturan lanjutan.
- **Won't have (fase ini)**: integrasi API SAUM, aplikasi native.

---

## 23. Acceptance Criteria

Setiap kriteria dapat diuji secara terpisah.

### 23.1 Autentikasi
- AC-AUT-01: Pengawas dengan nama terdaftar dapat membuat akun dan masuk.
- AC-AUT-02: Pengawas yang identitasnya sudah memiliki akun tidak dapat membuat akun kedua.
- AC-AUT-03: Password tersimpan dalam bentuk hash, tidak dalam teks biasa.

### 23.2 Impor
- AC-IMP-01: Dokumen PDF teks, PDF scan, XLSX, dan CSV dapat diunggah dan diproses.
- AC-IMP-02: Field yang tidak terbaca ditandai dan tidak terisi nilai tebakan.
- AC-IMP-03: Data tidak tersimpan sebelum Admin menekan KONFIRMASI SIMPAN.
- AC-IMP-04: Duplikasi nomor peserta terdeteksi dan ditampilkan.
- AC-IMP-05: File sumber tersimpan dengan sha256 dan tidak dapat diubah.

### 23.3 Generator
- AC-GEN-01: Sebelas dokumen dapat dihasilkan dan diunduh sebagai PDF.
- AC-GEN-02: Perubahan data menandai dokumen perlu dibuat ulang.

### 23.4 Jadwal
- AC-JDW-01: Jadwal berubah menjadi Aktif tepat ketika waktu mulai server tercapai (WIB).
- AC-JDW-02: Pengawas tidak dapat mengubah status jadwal melalui antarmuka maupun API.
- AC-JDW-03: Pengawas yang tidak bertugas tidak dapat membuka halaman pengawasan ruang tersebut (uji langsung ke URL).

### 23.5 Mengawasi Ujian
- AC-MGU-01: Mengklik kursi menampilkan detail peserta yang benar.
- AC-MGU-02: Peringatan tanpa alasan tidak dapat disimpan.
- AC-MGU-03: Peringatan 1, 2, 3 mengubah warna kursi sesuai ketentuan.
- AC-MGU-04: Peringatan 3 menghasilkan laporan kepada Admin.
- AC-MGU-05: Peringatan tidak dapat dihapus; koreksi tercatat sebagai entri baru.
- AC-MGU-06: Izin keluar mencatat waktu keluar dan kembali, serta durasi yang benar.
- AC-MGU-07: Satu peserta tidak dapat memiliki dua izin aktif.
- AC-MGU-08: Pembaruan oleh pengawas A tampil di layar pengawas B dalam 3 detik.
- AC-MGU-09: Dua pengawas mengubah kursi yang sama bersamaan: hanya satu yang tersimpan; yang lain diberi pemberitahuan.
- AC-MGU-10: Saat koneksi terputus, aksi tampil sebagai "menunggu sinkronisasi" dan tersimpan setelah koneksi pulih.

### 23.6 Upload dan Penyelesaian
- AC-UPL-01: Berita acara tidak dapat dikirim jika data kehadiran belum lengkap (BR-15).
- AC-UPL-02: Admin dapat meminta perbaikan dan pengawas dapat mengunggah versi baru.
- AC-UPL-03: Laporan Terverifikasi tidak dapat diubah pengawas.

### 23.7 Monitoring dan Audit
- AC-MON-01: Angka dashboard sesuai dengan data sumber pada uji sampel.
- AC-MON-02: Setiap tindakan kritis muncul di audit log dengan pelaku dan waktu server.
- AC-MON-03: Pengguna tidak dapat menghapus atau mengubah audit log.

---

## 24. Testing Plan

| Jenis pengujian | Cakupan | Metode | Kapan |
|---|---|---|---|
| Unit test | Fungsi validasi, perhitungan durasi, aturan status jadwal | Otomatis | Setiap fase |
| Fungsional | Seluruh FR dan acceptance criteria | Manual dan otomatis | Akhir setiap fase |
| Ekstraksi | Uji dengan kumpulan dokumen SAUM nyata (teks, scan, Excel, CSV) | Dataset uji dengan hasil acuan | Fase 2 |
| Keamanan | Akses tidak sah, eskalasi hak, injeksi, pembatasan login | Uji penetrasi dasar, review kode | Fase 6 |
| Integrasi | Impor → generator → Mengawasi Ujian → laporan → verifikasi | Skenario end-to-end | Fase 4–6 |
| Sinkronisasi | Dua perangkat bersamaan, koneksi putus-sambung, konflik | Simulasi jaringan | Fase 3 dan 6 |
| Kinerja | Ekstraksi dokumen besar; pembaruan denah dengan banyak pengguna | Uji beban | Fase 6 |
| Responsif dan aksesibilitas | Ponsel, tablet, desktop; kontras dan ukuran tombol | Uji perangkat | Fase 3 dan 6 |
| Waktu | Aktivasi jadwal pada jam mulai, perangkat dengan jam salah | Uji langsung | Fase 3 |
| UAT | Skenario nyata oleh Admin dan beberapa pengawas | Lapangan terbatas (simulasi ujian) | Fase 6 |

Kriteria lolos: tidak ada defek kritis atau tinggi yang terbuka; seluruh acceptance criteria prioritas Must terpenuhi; persetujuan tertulis Admin.

---

## 25. Risiko dan Mitigasi

| ID | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| R-01 | Ekstraksi OCR salah membaca nama atau nomor peserta | Tinggi | Pratinjau wajib, tanda keyakinan rendah, konfirmasi Admin, pengujian dengan dokumen nyata |
| R-02 | Koneksi putus saat ujian | Tinggi | Mode menunggu sinkronisasi, tidak menganggap data tersimpan sebelum server konfirmasi |
| R-03 | Konflik pembaruan dua pengawas | Sedang | Aturan BR-10, peringatan tidak pernah ditimpa |
| R-04 | Pengawas mengakses ruang yang bukan tugasnya | Tinggi | Pemeriksaan penugasan di server setiap permintaan, uji keamanan |
| R-05 | Data peserta bocor | Tinggi | Hak akses ketat, HTTPS, pembatasan unduhan, review keamanan, OD-10 |
| R-06 | Ketergantungan pada layanan AI pihak ketiga (AI Studio/model) | Sedang | Abstraksi layanan ekstraksi, rencana alternatif, pengujian berkala |
| R-07 | Format ekspor SAUM berubah | Sedang | Klasifikasi berbasis struktur, versi parser, dokumentasi contoh file |
| R-08 | Jam perangkat pengawas tidak akurat | Sedang | Semua waktu dari server (WIB) |
| R-09 | Pengawas kesulitan menggunakan aplikasi saat ujian | Sedang | UI sederhana, pelatihan singkat, uji lapangan |
| R-10 | Keputusan sanksi dilakukan otomatis oleh sistem | Tinggi | Sistem tidak mengeluarkan peserta; keputusan di tangan panitia (BR-06) |
| R-11 | Scope creep (fitur baru di luar PRD) | Sedang | Perubahan lewat persetujuan Admin dan revisi PRD |
| R-12 | Keterbatasan pengembangan di lingkungan AI Studio untuk kebutuhan backup dan deployment produksi | Sedang | Validasi kemampuan platform pada Fase 1 (OD-08, OD-09) |

---

## 26. Batasan Pengembangan

1. Jangan mengubah SAUM.
2. Jangan membangun ulang aplikasi administrasi ujian.
3. Jangan menghilangkan fitur SIPENGUJI yang sudah disetujui.
4. Jangan melakukan perubahan skema database tanpa analisis dampak.
5. Jangan melakukan migrasi teknologi tanpa alasan teknis tertulis.
6. Jangan melakukan deployment produksi tanpa persetujuan Admin.
7. Jangan mengarang data hasil ekstraksi.
8. Jangan memberi akses ruang kepada pengawas yang tidak bertugas.
9. Jangan menghapus audit log.
10. Jangan membuat keputusan sanksi otomatis terhadap peserta.
11. Jangan menganggap data yang belum tersinkronisasi sudah tersimpan.
12. Jangan mengimplementasikan fitur yang belum disetujui dalam PRD ini.

---

## 27. Daftar OPEN DECISION

| Kode | Pertanyaan | Dampak jika belum diputuskan | Pemilik keputusan |
|---|---|---|---|
| OD-01 | Apakah diperlukan integrasi API dengan SAUM di masa depan? | Arsitektur impor saat ini hanya file | Pemilik proyek |
| OD-02 | Mekanisme verifikasi identitas pengawas saat registrasi (misalnya kode dari Admin, NIP, atau nomor WhatsApp dengan OTP)? Dan prosedur lupa password? | Alur UC-01 belum final | Admin |
| OD-03 | Kebijakan password (panjang minimum, masa berlaku) dan durasi sesi tidak aktif. | Keamanan belum terukur | Admin dan tim keamanan |
| OD-04 | Batas ukuran file dan target waktu ekstraksi. | Kinerja dan batas unggah belum pasti | Tim pengembang |
| OD-05 | Durasi pemberitahuan sebelum ujian selesai (default diusulkan 15 menit). | Konfigurasi belum final | Admin |
| OD-06 | Push notification: apakah masuk fase awal atau lanjutan? | Ruang lingkup notifikasi | Pemilik proyek |
| OD-07 | Kebijakan retensi data dan backup (lama penyimpanan data peserta dan arsip). | Kepatuhan dan biaya penyimpanan | Pemilik proyek |
| OD-08 | Platform deployment produksi: tetap di AI Studio atau dipindahkan ke platform lain (misalnya Vercel atau Cloud Run)? | Strategi deployment | Pemilik proyek dan tim teknis |
| OD-09 | Pilihan database, layanan autentikasi, penyimpanan berkas, dan layanan realtime yang didukung di lingkungan AI Studio. Sekaligus audit apakah ada basis kode SIPENGUJI yang sudah ada. | Skema database final tertunda | Tim teknis |
| OD-10 | Kebijakan pemrosesan data peserta oleh layanan AI pihak ketiga (apakah dokumen boleh dikirim ke layanan model untuk OCR, dan bagaimana kebijakan retensi penyedia). | Risiko privasi | Pemilik proyek dan Admin |
| OD-11 | Format dan tanggal pasti jenis dokumen SAUM (contoh file ekspor nyata) untuk menyusun parser. | Akurasi ekstraksi | Admin dan pengelola SAUM |
| OD-12 | Aturan batas waktu pengajuan berita acara setelah sesi selesai. | Alur verifikasi | Admin |

---

## 28. Glosarium

| Istilah | Arti |
|---|---|
| SAUM | Aplikasi administrasi ujian madrasah yang sudah digunakan, sumber dokumen ekspor. |
| SIPENGUJI | Sistem Informasi Pengawasan Ujian Madrasah (aplikasi yang didokumentasikan ini). |
| Admin / Panitia | Pengguna pengelola kegiatan ujian dan verifikasi. |
| Pengawas | Guru yang bertugas mengawasi ujian. |
| Denah | Gambar susunan kursi di ruang ujian. |
| Peringatan | Catatan pelanggaran peserta dalam tiga tingkat. |
| Izin keluar | Pencatatan peserta yang meninggalkan ruang sementara. |
| Berita acara | Dokumen laporan pelaksanaan pengawasan. |
| Daftar hadir | Dokumen kehadiran peserta atau pengawas. |
| OCR | Pengenalan teks dari dokumen hasil scan atau foto. |
| WIB | Waktu Indonesia Barat (UTC+07:00). |
| Waktu server | Waktu resmi yang dicatat server, dipakai untuk semua aktivitas kritis. |
| Audit log | Catatan tak dapat diubah yang merekam setiap tindakan penting. |
| RBAC | Role-Based Access Control, pengendalian akses berdasarkan peran. |
| Single source of truth | Satu sumber data resmi yang menjadi acuan semua pihak. |
| Realtime | Pembaruan data yang tampil dalam hitungan detik. |
| UAT | User Acceptance Test, pengujian oleh pengguna sebelum produksi. |

---

## 29. Lampiran

### Lampiran A — Contoh Alur Peringatan Bertingkat
1. Peserta mengobrol keras. Pengawas memilih kursi peserta → Peringatan 1 → alasan "mengobrol saat ujian" → kursi hijau.
2. Peserta mengulangi. Peringatan 2 → alasan → kursi kuning.
3. Peserta melanggar lagi. Peringatan 3 → alasan → kursi merah → laporan terkirim ke Admin.
4. Admin meninjau riwayat dan memutuskan tindak lanjut sesuai tata tertib. Sistem tidak mengeluarkan peserta.

### Lampiran B — Contoh Alur Izin Keluar
1. Peserta meminta izin ke kamar kecil pukul 08:45 WIB. Pengawas memilih kursi → IZIN KELUAR → alasan → waktu keluar tercatat 08:45:10.
2. Kursi abu-abu dengan ikon jam.
3. Peserta kembali pukul 08:50. Pengawas menekan KEMBALI → durasi 5 menit tercatat.

### Lampiran C — Contoh Konflik Sinkronisasi
Pengawas A dan B sama-sama memberi Peringatan 1 kepada peserta yang sama dalam satu detik. Server menerima keduanya; keduanya tersimpan sebagai dua entri peringatan berurutan dengan pelaku masing-masing. Tidak ada entri yang ditimpa (BR-10).

### Lampiran D — Daftar Dokumen Administrasi yang Dihasilkan
1. Cover administrasi pengawasan
2. Denah lingkungan ujian
3. Denah peserta ujian
4. Jadwal ujian
5. Tata tertib peserta
6. Tata tertib pengawas
7. Daftar hadir peserta
8. Daftar hadir pengawas
9. Berita acara
10. Formulir catatan kejadian khusus
11. Dokumen serah terima berkas ujian

### Lampiran E — Catatan Khusus Pengembangan di Google AI Studio
- Proyek SIPENGUJI dibangun sebagai proyek baru di Google AI Studio. Jika sudah ada basis kode atau data sebelumnya, audit dilakukan sesuai OD-09 sebelum skema final ditetapkan.
- Pengembangan tetap mengikuti batasan pada Bagian 26. Tidak ada perubahan pada SAUM.
- Setiap perubahan kode atau skema pada tahap implementasi wajib dicatat dalam riwayat revisi dokumen ini.
