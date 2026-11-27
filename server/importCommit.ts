import { db, ensureGeneratedDocRows, markGeneratedDocumentsStale } from './db.ts';
import type { ImportDocType } from '../src/types.ts';
import { getServerWibNow } from './time.ts';

function ensureActiveExam(userId: number | null): number {
  const existing = db
    .prepare(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`)
    .get() as { id: number } | undefined;
  if (existing) return existing.id;

  const today = getServerWibNow().date;
  const res = db
    .prepare(
      `INSERT INTO exams (nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status, warning_minutes_before_end, created_at)
       VALUES (?, ?, ?, ?, ?, 'aktif', 15, ?)`
    )
    .run(
      'Asesmen Sumatif Akhir Tahun Madrasah',
      'MAN 1 Nusantara',
      '2026/2027',
      today,
      today,
      getServerWibNow().isoWib
    );
  const examId = Number(res.lastInsertRowid);
  ensureGeneratedDocRows(examId, userId);
  return examId;
}

export function commitImportBatch(params: {
  batchId: number;
  docType: ImportDocType;
  rows: Array<Record<string, unknown>>;
  examId?: number | null;
  userId: number;
}): { examId: number; inserted: number; updated: number; skipped: number } {
  const now = getServerWibNow().isoWib;
  const examId = params.examId || ensureActiveExam(params.userId);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    if (params.docType === 'data_pengawas') {
      const findByNip = db.prepare(`SELECT id FROM supervisors WHERE nip_nuptk = ?`);
      const findByName = db.prepare(`SELECT id FROM supervisors WHERE LOWER(nama_lengkap) = LOWER(?)`);
      const insertSup = db.prepare(
        `INSERT INTO supervisors (nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`
      );
      const updateSup = db.prepare(
        `UPDATE supervisors SET nama_lengkap = ?, whatsapp = COALESCE(?, whatsapp), kode_verifikasi = COALESCE(?, kode_verifikasi) WHERE id = ?`
      );

      for (const r of params.rows) {
        const nama = r.nama_lengkap ? String(r.nama_lengkap).trim() : '';
        if (!nama) {
          skipped++;
          continue;
        }
        const nip = r.nip_nuptk ? String(r.nip_nuptk).trim() : null;
        const wa = r.whatsapp ? String(r.whatsapp).trim() : null;
        const kode = r.kode_verifikasi ? String(r.kode_verifikasi).trim() : null;

        const existing = (nip ? findByNip.get(nip) : undefined) || findByName.get(nama);
        if (existing && typeof (existing as { id: number }).id === 'number') {
          updateSup.run(nama, wa, kode, (existing as { id: number }).id);
          updated++;
        } else {
          insertSup.run(nama, nip, wa, kode, now);
          inserted++;
        }
      }
    } else if (params.docType === 'data_peserta' || params.docType === 'daftar_hadir_peserta') {
      const findStudent = db.prepare(`SELECT id FROM students WHERE exam_id = ? AND nomor_peserta = ?`);
      const insertStudent = db.prepare(
        `INSERT INTO students (exam_id, nomor_peserta, nisn, nis, nama, kelas) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const updateStudent = db.prepare(
        `UPDATE students SET nisn = COALESCE(?, nisn), nis = COALESCE(?, nis), nama = ?, kelas = ? WHERE id = ?`
      );
      const findRoom = db.prepare(`SELECT id FROM rooms WHERE kode = ?`);
      const insertRoom = db.prepare(
        `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count) VALUES (?, ?, 30, 5, 6)`
      );
      const countRoomSeats = db.prepare(`SELECT COUNT(*) AS cnt FROM seats WHERE room_id = ?`);
      const findSeatByStudent = db.prepare(`SELECT id FROM seats WHERE room_id = ? AND student_id = ?`);
      const insertSeat = db.prepare(
        `INSERT OR IGNORE INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const r of params.rows) {
        const nomor = r.nomor_peserta ? String(r.nomor_peserta).trim() : '';
        const nama = r.nama ? String(r.nama).trim() : '';
        const kelas = r.kelas ? String(r.kelas).trim() : 'Umum';
        if (!nomor || !nama) {
          skipped++;
          continue;
        }
        const nisn = r.nisn ? String(r.nisn).trim() : null;
        const nis = r.nis ? String(r.nis).trim() : null;

        let studentId: number;
        const existing = findStudent.get(examId, nomor) as { id: number } | undefined;
        if (existing) {
          updateStudent.run(nisn, nis, nama, kelas, existing.id);
          studentId = existing.id;
          updated++;
        } else {
          const res = insertStudent.run(examId, nomor, nisn, nis, nama, kelas);
          studentId = Number(res.lastInsertRowid);
          inserted++;
        }

        if (r.kode_ruang) {
          const kodeRuang = String(r.kode_ruang).trim();
          let room = findRoom.get(kodeRuang) as { id: number } | undefined;
          if (!room) {
            const namaRuang = r.nama_ruang ? String(r.nama_ruang).trim() : `Ruang ${kodeRuang}`;
            const rr = insertRoom.run(kodeRuang, namaRuang);
            room = { id: Number(rr.lastInsertRowid) };
          }
          const hasSeat = findSeatByStudent.get(room.id, studentId);
          if (!hasSeat) {
            const cnt = (countRoomSeats.get(room.id) as { cnt: number }).cnt;
            const baris = Math.floor(cnt / 5) + 1;
            const kolom = (cnt % 5) + 1;
            const rowLetter = String.fromCharCode(64 + baris);
            const kodeKursi = `${rowLetter}${kolom}`;
            insertSeat.run(room.id, kodeKursi, baris, kolom, kolom, baris, studentId);
          }
        }
      }
    } else if (params.docType === 'denah_peserta' || params.docType === 'pembagian_ruang') {
      const findRoom = db.prepare(`SELECT id, rows_count, cols_count FROM rooms WHERE kode = ?`);
      const insertRoom = db.prepare(
        `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count) VALUES (?, ?, ?, ?, ?)`
      );
      const updateRoomDims = db.prepare(
        `UPDATE rooms SET rows_count = MAX(rows_count, ?), cols_count = MAX(cols_count, ?), kapasitas = MAX(kapasitas, ?) WHERE id = ?`
      );
      const findStudent = db.prepare(`SELECT id FROM students WHERE exam_id = ? AND nomor_peserta = ?`);
      const insertStudent = db.prepare(
        `INSERT INTO students (exam_id, nomor_peserta, nama, kelas) VALUES (?, ?, ?, ?)`
      );
      const upsertSeat = db.prepare(
        `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, kode_kursi) DO UPDATE SET
           baris = excluded.baris,
           kolom = excluded.kolom,
           posisi_x = excluded.posisi_x,
           posisi_y = excluded.posisi_y,
           student_id = COALESCE(excluded.student_id, seats.student_id)`
      );

      for (let i = 0; i < params.rows.length; i++) {
        const r = params.rows[i];
        const kodeRuang = r.kode_ruang ? String(r.kode_ruang).trim() : '';
        if (!kodeRuang) {
          skipped++;
          continue;
        }
        const namaRuang = r.nama_ruang ? String(r.nama_ruang).trim() : `Ruang ${kodeRuang}`;
        const kapasitas = r.kapasitas ? Math.max(1, Number(r.kapasitas) || 20) : 20;
        const baris = Math.max(1, Number(r.baris) || Math.floor(i / 5) + 1);
        const kolom = Math.max(1, Number(r.kolom) || (i % 5) + 1);
        const kodeKursi = r.kode_kursi
          ? String(r.kode_kursi).trim()
          : `${String.fromCharCode(64 + baris)}${kolom}`;

        let room = findRoom.get(kodeRuang) as { id: number; rows_count: number; cols_count: number } | undefined;
        if (!room) {
          const rr = insertRoom.run(kodeRuang, namaRuang, kapasitas, Math.max(4, baris), Math.max(5, kolom));
          room = { id: Number(rr.lastInsertRowid), rows_count: Math.max(4, baris), cols_count: Math.max(5, kolom) };
        } else {
          updateRoomDims.run(baris, kolom, kapasitas, room.id);
        }

        let studentId: number | null = null;
        if (r.nomor_peserta) {
          const nomor = String(r.nomor_peserta).trim();
          const st = findStudent.get(examId, nomor) as { id: number } | undefined;
          if (st) {
            studentId = st.id;
          } else if (r.nama) {
            const sr = insertStudent.run(
              examId,
              nomor,
              String(r.nama).trim(),
              r.kelas ? String(r.kelas).trim() : 'Umum'
            );
            studentId = Number(sr.lastInsertRowid);
          }
        }

        upsertSeat.run(room.id, kodeKursi, baris, kolom, kolom, baris, studentId);
        inserted++;
      }
    } else if (params.docType === 'jadwal_ujian' || params.docType === 'jadwal_pengawasan') {
      const findSession = db.prepare(
        `SELECT id FROM exam_sessions WHERE exam_id = ? AND nama_sesi = ? AND tanggal = ?`
      );
      const insertSession = db.prepare(
        `INSERT INTO exam_sessions (exam_id, nama_sesi, tanggal, jam_mulai, jam_selesai) VALUES (?, ?, ?, ?, ?)`
      );
      const findSubject = db.prepare(`SELECT id FROM subjects WHERE kode = ? OR LOWER(nama) = LOWER(?)`);
      const insertSubject = db.prepare(`INSERT INTO subjects (kode, nama) VALUES (?, ?)`);
      const findRoom = db.prepare(`SELECT id FROM rooms WHERE kode = ?`);
      const insertRoom = db.prepare(
        `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count) VALUES (?, ?, 20, 4, 5)`
      );
      const findSchedule = db.prepare(
        `SELECT id FROM exam_schedules WHERE exam_session_id = ? AND room_id = ? AND tanggal = ? AND jam_mulai = ?`
      );
      const insertSchedule = db.prepare(
        `INSERT INTO exam_schedules (exam_session_id, subject_id, room_id, tanggal, jam_mulai, jam_selesai)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const findSupByName = db.prepare(`SELECT id FROM supervisors WHERE LOWER(nama_lengkap) = LOWER(?)`);
      const insertSup = db.prepare(
        `INSERT INTO supervisors (nama_lengkap, status, created_at) VALUES (?, 'active', ?)`
      );
      const upsertAssign = db.prepare(
        `INSERT INTO supervision_assignments (supervisor_id, room_id, exam_session_id, exam_schedule_id, peran, status_jadwal)
         VALUES (?, ?, ?, ?, ?, 'akan_datang')
         ON CONFLICT(supervisor_id, exam_schedule_id) DO UPDATE SET peran = excluded.peran`
      );

      for (const r of params.rows) {
        const tanggal = r.tanggal ? String(r.tanggal).trim() : getServerWibNow().date;
        const jamMulai = r.jam_mulai ? String(r.jam_mulai).trim() : '';
        const jamSelesai = r.jam_selesai ? String(r.jam_selesai).trim() : '';
        const mapelNama = r.mata_pelajaran ? String(r.mata_pelajaran).trim() : '';
        const kodeRuang = r.kode_ruang ? String(r.kode_ruang).trim() : '';
        if (!jamMulai || !jamSelesai || !mapelNama || !kodeRuang) {
          skipped++;
          continue;
        }
        const namaSesi = r.nama_sesi ? String(r.nama_sesi).trim() : 'Sesi 1';
        const kodeMapel = r.kode_mapel
          ? String(r.kode_mapel).trim()
          : mapelNama.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12);

        let sess = findSession.get(examId, namaSesi, tanggal) as { id: number } | undefined;
        if (!sess) {
          const sr = insertSession.run(examId, namaSesi, tanggal, jamMulai, jamSelesai);
          sess = { id: Number(sr.lastInsertRowid) };
        }

        let subj = findSubject.get(kodeMapel, mapelNama) as { id: number } | undefined;
        if (!subj) {
          const sbr = insertSubject.run(kodeMapel, mapelNama);
          subj = { id: Number(sbr.lastInsertRowid) };
        }

        let room = findRoom.get(kodeRuang) as { id: number } | undefined;
        if (!room) {
          const namaRuang = r.nama_ruang ? String(r.nama_ruang).trim() : `Ruang ${kodeRuang}`;
          const rr = insertRoom.run(kodeRuang, namaRuang);
          room = { id: Number(rr.lastInsertRowid) };
        }

        let sched = findSchedule.get(sess.id, room.id, tanggal, jamMulai) as { id: number } | undefined;
        if (!sched) {
          const schr = insertSchedule.run(sess.id, subj.id, room.id, tanggal, jamMulai, jamSelesai);
          sched = { id: Number(schr.lastInsertRowid) };
          inserted++;
        } else {
          updated++;
        }

        const assignSupervisor = (rawName: unknown, peran: 'utama' | 'pendamping') => {
          if (!rawName || String(rawName).trim() === '') return;
          const namaSup = String(rawName).trim();
          let sup = findSupByName.get(namaSup) as { id: number } | undefined;
          if (!sup) {
            const sr = insertSup.run(namaSup, now);
            sup = { id: Number(sr.lastInsertRowid) };
          }
          upsertAssign.run(sup.id, room!.id, sess!.id, sched!.id, peran);
        };

        assignSupervisor(r.pengawas_utama, 'utama');
        assignSupervisor(r.pengawas_pendamping, 'pendamping');
      }
    } else {
      // denah_lingkungan or dokumen_pendukung archived as confirmed
      inserted = params.rows.length;
    }

    db.prepare(
      `UPDATE import_batches SET exam_id = ?, detected_type = ?, extracted_json = ?, status = 'confirmed', confirmed_at = ? WHERE id = ?`
    ).run(examId, params.docType, JSON.stringify(params.rows), now, params.batchId);

    markGeneratedDocumentsStale(examId);
  });

  tx();
  return { examId, inserted, updated, skipped };
}
