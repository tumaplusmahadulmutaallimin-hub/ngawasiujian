import { jsPDF } from 'jspdf';
import type { SupervisionScheduleItem } from '../types.ts';

export interface DocDataset {
  serverTime: { date: string; time: string; isoWib: string };
  exam: {
    id: number;
    nama: string;
    madrasah_nama: string;
    tahun_ajaran: string;
    tanggal_mulai: string;
    tanggal_selesai: string;
  } | null;
  rooms: Array<{
    id: number;
    kode: string;
    nama: string;
    kapasitas: number;
    rows_count: number;
    cols_count: number;
    seats: Array<{
      kode_kursi: string;
      baris: number;
      kolom: number;
      nomor_peserta?: string;
      nisn?: string;
      student_nama?: string;
      kelas?: string;
    }>;
  }>;
  supervisors: Array<{
    id: number;
    nama_lengkap: string;
    nip_nuptk: string | null;
    whatsapp: string | null;
  }>;
  schedules: SupervisionScheduleItem[];
  incidents: Array<{
    id: number;
    exam_schedule_id: number;
    deskripsi: string;
    waktu: string;
    dicatat_oleh_nama: string;
  }>;
  warnings: Array<{
    id: number;
    student_nama: string;
    nomor_peserta: string;
    tingkat: number;
    alasan: string;
    waktu_server: string;
    dicatat_oleh_nama: string;
  }>;
}

export function generateAdminDocumentPdf(
  docKey: string,
  title: string,
  dataset: DocDataset,
  version = 1,
  roomFilterKode?: string
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const madrasah = dataset.exam?.madrasah_nama || 'Madrasah Aliyah Negeri';
  const examName = dataset.exam?.nama || 'Ujian Madrasah';
  const tahun = dataset.exam?.tahun_ajaran || '2026/2027';
  const generatedLabel = `${dataset.serverTime.date} ${dataset.serverTime.time} WIB (v${version})`;

  const drawHeader = (subtitle: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('KEMENTERIAN AGAMA REPUBLIK INDONESIA', 105, 16, { align: 'center' });
    doc.setFontSize(14);
    doc.text(madrasah.toUpperCase(), 105, 23, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`${examName} — Tahun Pelajaran ${tahun}`, 105, 29, { align: 'center' });
    doc.setLineWidth(0.6);
    doc.line(15, 33, 195, 33);
    doc.setLineWidth(0.2);
    doc.line(15, 34.2, 195, 34.2);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(subtitle.toUpperCase(), 105, 43, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Dibuat oleh SIPENGUJI · ${generatedLabel}`, 105, 48, { align: 'center' });
    doc.setTextColor(0);
  };

  drawHeader(title.replace(/^\d+\.\s*/, ''));
  let y = 58;

  const targetRooms = roomFilterKode
    ? dataset.rooms.filter((r) => r.kode === roomFilterKode)
    : dataset.rooms;

  if (docKey === 'cover') {
    doc.setDrawColor(4, 120, 87);
    doc.setLineWidth(0.8);
    doc.rect(20, 56, 170, 210);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('ADMINISTRASI PENGAWASAN', 105, 95, { align: 'center' });
    doc.setFontSize(15);
    doc.text(examName.toUpperCase(), 105, 106, { align: 'center' });
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.text(`Tahun Ajaran ${tahun}`, 105, 116, { align: 'center' });

    const roomLabel = targetRooms[0] ? `${targetRooms[0].kode} — ${targetRooms[0].nama}` : 'Semua Ruang Ujian';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(roomLabel, 105, 145, { align: 'center' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Periode: ${dataset.exam?.tanggal_mulai || '-'} s.d. ${dataset.exam?.tanggal_selesai || '-'}`, 105, 157, { align: 'center' });
    doc.text(`Jumlah Ruang Terdaftar: ${dataset.rooms.length} Ruang`, 105, 165, { align: 'center' });
    doc.text(`Jumlah Pengawas: ${dataset.supervisors.length} Orang`, 105, 173, { align: 'center' });

    doc.setFontSize(10);
    doc.text('PANITIA PENYELENGGARA UJIAN MADRASAH', 105, 240, { align: 'center' });
    doc.text(madrasah, 105, 247, { align: 'center' });
  } else if (docKey === 'denah_lingkungan') {
    doc.setFontSize(10);
    doc.text('Peta Distribusi Ruang Ujian di Lingkungan Madrasah:', 15, y);
    y += 8;
    let x = 15;
    targetRooms.forEach((r, idx) => {
      doc.setDrawColor(51, 65, 85);
      doc.rect(x, y, 54, 28);
      doc.setFont('helvetica', 'bold');
      doc.text(r.kode, x + 4, y + 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(r.nama.slice(0, 26), x + 4, y + 15);
      doc.text(`Kapasitas: ${r.kapasitas} kursi`, x + 4, y + 22);
      doc.setFontSize(10);
      x += 60;
      if ((idx + 1) % 3 === 0) {
        x = 15;
        y += 34;
      }
    });
  } else if (docKey === 'denah_peserta') {
    const room = targetRooms[0];
    if (!room) {
      doc.text('Belum ada data ruang dan denah peserta yang dikonfirmasi.', 15, y);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.text(`Ruang: ${room.kode} — ${room.nama}`, 15, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text('[ MEJA PENGAWAS / PAPAN TULIS ]', 105, y + 4, { align: 'center' });
      doc.rect(60, y, 90, 7);
      y += 14;

      const cols = Math.max(1, room.cols_count || 4);
      const cellW = Math.min(42, 180 / cols);
      const cellH = 22;

      for (const s of room.seats) {
        const cx = 15 + (s.kolom - 1) * (cellW + 2);
        const cy = y + (s.baris - 1) * (cellH + 3);
        if (cy > 265) break;
        doc.rect(cx, cy, cellW, cellH);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(s.kode_kursi, cx + 2, cy + 5);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text((s.student_nama || 'Kosong').slice(0, 18), cx + 2, cy + 11);
        doc.text((s.nomor_peserta || '-').slice(0, 16), cx + 2, cy + 16);
      }
    }
  } else if (docKey === 'jadwal_ujian') {
    doc.setFontSize(9);
    const headers = ['Tanggal', 'Waktu WIB', 'Sesi', 'Ruang', 'Mata Pelajaran', 'Pengawas'];
    const widths = [24, 26, 26, 22, 42, 42];
    let x = 15;
    doc.setFont('helvetica', 'bold');
    headers.forEach((h, i) => {
      doc.rect(x, y, widths[i], 8);
      doc.text(h, x + 2, y + 5.5);
      x += widths[i];
    });
    y += 8;
    doc.setFont('helvetica', 'normal');
    for (const s of dataset.schedules) {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      x = 15;
      const sups = s.co_supervisors.map((c) => c.nama_lengkap).join(', ') || '-';
      const vals = [
        s.tanggal,
        `${s.jam_mulai}-${s.jam_selesai}`,
        s.nama_sesi.slice(0, 14),
        s.room_kode,
        s.subject_nama.slice(0, 22),
        sups.slice(0, 22),
      ];
      vals.forEach((v, i) => {
        doc.rect(x, y, widths[i], 8);
        doc.text(String(v), x + 2, y + 5.5);
        x += widths[i];
      });
      y += 8;
    }
  } else if (docKey === 'tata_tertib_peserta' || docKey === 'tata_tertib_pengawas') {
    const items =
      docKey === 'tata_tertib_peserta'
        ? [
            '1. Peserta hadir di ruang ujian paling lambat 15 menit sebelum ujian dimulai.',
            '2. Peserta menempati kursi sesuai nomor peserta dan denah yang ditetapkan panitia.',
            '3. Peserta dilarang membawa alat komunikasi, catatan, atau perangkat elektronik ke kursi ujian.',
            '4. Peserta wajib mengisi daftar hadir dan menjaga ketenangan selama ujian berlangsung.',
            '5. Peserta yang meninggalkan ruangan sementara wajib meminta izin kepada pengawas ruang.',
            '6. Pelanggaran tata tertib dicatat secara berjenjang (Peringatan 1, 2, dan 3) untuk tindak lanjut panitia.',
          ]
        : [
            '1. Pengawas hadir di ruang ujian paling lambat 20 menit sebelum sesi ujian dimulai.',
            '2. Pengawas melakukan verifikasi identitas peserta dan kesesuaian tempat duduk pada denah.',
            '3. Pengawas mencatat kehadiran peserta dan pengawas pada sistem SIPENGUJI.',
            '4. Pengawas menjaga ketertiban ruang serta mencatat setiap peringatan dengan alasan yang objektif.',
            '5. Pengawas mencatat waktu keluar dan waktu kembali peserta yang mengajukan izin keluar.',
            '6. Pada akhir sesi, pengawas menyusun Berita Acara serta mengunggah Daftar Hadir bertanda tangan.',
          ];
    doc.setFontSize(10.5);
    for (const line of items) {
      const wrapped = doc.splitTextToSize(line, 175);
      doc.text(wrapped, 15, y);
      y += wrapped.length * 6 + 3;
    }
  } else if (docKey === 'daftar_hadir_peserta') {
    const room = targetRooms[0];
    const seats = room ? room.seats.filter((s) => s.student_nama) : [];
    doc.setFontSize(9);
    doc.text(`Ruang: ${room ? `${room.kode} — ${room.nama}` : 'Semua Ruang'}`, 15, y);
    y += 6;
    const cols = ['No', 'Kursi', 'No. Peserta', 'Nama Peserta', 'Kelas', 'Paraf'];
    const widths = [10, 16, 34, 64, 28, 28];
    let x = 15;
    doc.setFont('helvetica', 'bold');
    cols.forEach((h, i) => {
      doc.rect(x, y, widths[i], 8);
      doc.text(h, x + 2, y + 5.5);
      x += widths[i];
    });
    y += 8;
    doc.setFont('helvetica', 'normal');
    seats.forEach((st, idx) => {
      if (y > 272) {
        doc.addPage();
        y = 20;
      }
      x = 15;
      const vals = [
        String(idx + 1),
        st.kode_kursi,
        st.nomor_peserta || '-',
        (st.student_nama || '-').slice(0, 32),
        (st.kelas || '-').slice(0, 14),
        '',
      ];
      vals.forEach((v, i) => {
        doc.rect(x, y, widths[i], 8);
        doc.text(v, x + 2, y + 5.5);
        x += widths[i];
      });
      y += 8;
    });
  } else if (docKey === 'daftar_hadir_pengawas') {
    const cols = ['No', 'Nama Pengawas', 'NIP / NUPTK', 'WhatsApp', 'Paraf'];
    const widths = [12, 66, 44, 34, 26];
    let x = 15;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    cols.forEach((h, i) => {
      doc.rect(x, y, widths[i], 8);
      doc.text(h, x + 2, y + 5.5);
      x += widths[i];
    });
    y += 8;
    doc.setFont('helvetica', 'normal');
    dataset.supervisors.forEach((sup, idx) => {
      if (y > 272) {
        doc.addPage();
        y = 20;
      }
      x = 15;
      const vals = [String(idx + 1), sup.nama_lengkap.slice(0, 32), sup.nip_nuptk || '-', sup.whatsapp || '-', ''];
      vals.forEach((v, i) => {
        doc.rect(x, y, widths[i], 8);
        doc.text(v, x + 2, y + 5.5);
        x += widths[i];
      });
      y += 8;
    });
  } else if (docKey === 'berita_acara') {
    const sched = dataset.schedules[0];
    doc.setFontSize(10);
    const lines = [
      `Pada hari ini, tanggal ${sched?.tanggal || dataset.serverTime.date}, telah dilaksanakan pengawasan ${examName}:`,
      `• Ruang Ujian : ${sched ? `${sched.room_kode} — ${sched.room_nama}` : '-'}`,
      `• Mata Pelajaran : ${sched?.subject_nama || '-'}`,
      `• Sesi / Waktu : ${sched ? `${sched.nama_sesi} (${sched.jam_mulai} - ${sched.jam_selesai} WIB)` : '-'}`,
      `• Jumlah Peserta Terdaftar : ${targetRooms[0]?.seats.filter((s) => s.student_nama).length || 0} peserta`,
      '• Kondisi Pelaksanaan : ________________________________________________',
      '• Catatan Khusus : ____________________________________________________',
    ];
    for (const l of lines) {
      doc.text(l, 15, y);
      y += 9;
    }
    y += 15;
    doc.text('Pengawas Utama,', 35, y);
    doc.text('Pengawas Pendamping,', 135, y);
    y += 24;
    doc.text('( ______________________ )', 28, y);
    doc.text('( ______________________ )', 128, y);
  } else if (docKey === 'catatan_kejadian') {
    doc.setFontSize(9.5);
    if (dataset.incidents.length === 0 && dataset.warnings.length === 0) {
      doc.text('Belum ada catatan kejadian khusus atau peringatan tercatat.', 15, y);
    } else {
      for (const inc of dataset.incidents) {
        doc.text(`[Kejadian] ${inc.waktu} · ${inc.dicatat_oleh_nama}: ${inc.deskripsi}`, 15, y);
        y += 7;
      }
      for (const w of dataset.warnings.slice(0, 20)) {
        doc.text(`[Peringatan ${w.tingkat}] ${w.waktu_server} · ${w.student_nama} (${w.nomor_peserta}): ${w.alasan}`, 15, y);
        y += 7;
      }
    }
  } else if (docKey === 'serah_terima') {
    doc.setFontSize(10);
    doc.text('Berita Serah Terima Berkas Ujian dari Pengawas Ruang kepada Panitia Ujian:', 15, y);
    y += 10;
    const checklist = [
      '[ ] Amplop Naskah / Berkas Soal',
      '[ ] Lembar Jawaban Peserta (LJU)',
      '[ ] Daftar Hadir Peserta Bertanda Tangan',
      '[ ] Daftar Hadir Pengawas',
      '[ ] Berita Acara Pelaksanaan Ujian',
      '[ ] Formulir Catatan Kejadian Khusus',
    ];
    for (const item of checklist) {
      doc.text(item, 20, y);
      y += 8;
    }
    y += 16;
    doc.text('Yang Menyerahkan (Pengawas),', 30, y);
    doc.text('Yang Menerima (Panitia),', 130, y);
    y += 24;
    doc.text('( ______________________ )', 28, y);
    doc.text('( ______________________ )', 128, y);
  }

  doc.save(`SIPENGUJI_${docKey}_v${version}.pdf`);
}

export function generateRecapPdf(
  summary: Record<string, number>,
  schedules: SupervisionScheduleItem[],
  serverTimeLabel: string
): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('REKAPITULASI PENGAWASAN UJIAN MADRASAH — SIPENGUJI', 148, 16, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Dicetak pada: ${serverTimeLabel}`, 148, 22, { align: 'center' });

  let y = 32;
  doc.setFontSize(9.5);
  doc.text(
    `Ruang Aktif: ${summary.activeRoomsCount ?? 0} / ${summary.totalRooms ?? 0}   |   Pengawas Hadir: ${summary.checkedInSupervisors ?? 0}/${summary.totalSupervisors ?? 0}   |   Peserta Hadir: ${summary.studentHadir ?? 0}   |   Peringatan 3: ${summary.level3Count ?? 0}   |   Laporan Terkirim: ${summary.submittedReports ?? 0}`,
    15,
    y
  );
  y += 10;

  const cols = ['Tanggal', 'Waktu WIB', 'Ruang', 'Mata Pelajaran', 'Pengawas', 'Status Jadwal', 'Status Laporan'];
  const widths = [28, 30, 38, 52, 62, 28, 30];
  let x = 15;
  doc.setFont('helvetica', 'bold');
  cols.forEach((c, i) => {
    doc.rect(x, y, widths[i], 8);
    doc.text(c, x + 2, y + 5.5);
    x += widths[i];
  });
  y += 8;
  doc.setFont('helvetica', 'normal');
  for (const s of schedules) {
    if (y > 185) {
      doc.addPage();
      y = 20;
    }
    x = 15;
    const sups = s.co_supervisors.map((c) => c.nama_lengkap).join(', ') || '-';
    const vals = [
      s.tanggal,
      `${s.jam_mulai}-${s.jam_selesai}`,
      `${s.room_kode} ${s.room_nama}`.slice(0, 20),
      s.subject_nama.slice(0, 28),
      sups.slice(0, 32),
      s.computed_status,
      s.report_status,
    ];
    vals.forEach((v, i) => {
      doc.rect(x, y, widths[i], 8);
      doc.text(String(v), x + 2, y + 5.5);
      x += widths[i];
    });
    y += 8;
  }

  doc.save(`Rekap_Pengawasan_SIPENGUJI.pdf`);
}
