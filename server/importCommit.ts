import type { PoolClient } from 'pg';
import {
  ensureGeneratedDocRows,
  execute,
  markGeneratedDocumentsStale,
  queryOne,
  withTransaction,
} from './db.ts';
import type { ImportDocType } from '../src/types.ts';
import { getServerWibNow } from './time.ts';

async function ensureActiveExam(userId: number | null, client: PoolClient): Promise<number> {
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM exams ORDER BY id DESC LIMIT 1`,
    [],
    client
  );
  if (existing) return Number(existing.id);

  const today = getServerWibNow().date;
  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO exams (nama, madrasah_nama, tahun_ajaran, tanggal_mulai, tanggal_selesai, status, warning_minutes_before_end, created_at)
     VALUES ($1, $2, $3, $4, $5, 'aktif', 15, $6)
     RETURNING id`,
    [
      'Asesmen Sumatif Akhir Tahun Madrasah',
      'MAN 1 Nusantara',
      '2026/2027',
      today,
      today,
      getServerWibNow().isoWib,
    ],
    client
  );
  const examId = Number(inserted!.id);
  await ensureGeneratedDocRows(examId, userId, client);
  return examId;
}

export async function commitImportBatch(params: {
  batchId: number;
  docType: ImportDocType;
  rows: Array<Record<string, unknown>>;
  examId?: number | null;
  userId: number;
}): Promise<{ examId: number; inserted: number; updated: number; skipped: number }> {
  const now = getServerWibNow().isoWib;

  return withTransaction(async (client) => {
    const examId = params.examId || (await ensureActiveExam(params.userId, client));
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    if (params.docType === 'data_pengawas') {
      for (const r of params.rows) {
        const nama = r.nama_lengkap ? String(r.nama_lengkap).trim() : '';
        if (!nama) {
          skipped++;
          continue;
        }
        const nip = r.nip_nuptk ? String(r.nip_nuptk).trim() : null;
        const wa = r.whatsapp ? String(r.whatsapp).trim() : null;
        const kode = r.kode_verifikasi ? String(r.kode_verifikasi).trim() : null;

        const existing =
          (nip
            ? await queryOne<{ id: number }>(
                `SELECT id FROM supervisors WHERE nip_nuptk = $1`,
                [nip],
                client
              )
            : null) ||
          (await queryOne<{ id: number }>(
            `SELECT id FROM supervisors WHERE LOWER(nama_lengkap) = LOWER($1)`,
            [nama],
            client
          ));

        if (existing) {
          await execute(
            `UPDATE supervisors
             SET nama_lengkap = $1,
                 whatsapp = COALESCE($2, whatsapp),
                 kode_verifikasi = COALESCE($3, kode_verifikasi)
             WHERE id = $4`,
            [nama, wa, kode, existing.id],
            client
          );
          updated++;
        } else {
          await execute(
            `INSERT INTO supervisors (nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi, status, created_at)
             VALUES ($1, $2, $3, $4, 'active', $5)`,
            [nama, nip, wa, kode, now],
            client
          );
          inserted++;
        }
      }
    } else if (params.docType === 'data_peserta' || params.docType === 'daftar_hadir_peserta') {
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
        const existing = await queryOne<{ id: number }>(
          `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2`,
          [examId, nomor],
          client
        );

        if (existing) {
          await execute(
            `UPDATE students
             SET nisn = COALESCE($1, nisn), nis = COALESCE($2, nis), nama = $3, kelas = $4
             WHERE id = $5`,
            [nisn, nis, nama, kelas, existing.id],
            client
          );
          studentId = Number(existing.id);
          updated++;
        } else {
          const insertedStudent = await queryOne<{ id: number }>(
            `INSERT INTO students (exam_id, nomor_peserta, nisn, nis, nama, kelas)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [examId, nomor, nisn, nis, nama, kelas],
            client
          );
          studentId = Number(insertedStudent!.id);
          inserted++;
        }

        if (r.kode_ruang) {
          const kodeRuang = String(r.kode_ruang).trim();
          let room = await queryOne<{ id: number }>(
            `SELECT id FROM rooms WHERE kode = $1`,
            [kodeRuang],
            client
          );
          if (!room) {
            const namaRuang = r.nama_ruang ? String(r.nama_ruang).trim() : `Ruang ${kodeRuang}`;
            room = await queryOne<{ id: number }>(
              `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
               VALUES ($1, $2, 30, 5, 6)
               RETURNING id`,
              [kodeRuang, namaRuang],
              client
            );
          }

          const hasSeat = await queryOne<{ id: number }>(
            `SELECT id FROM seats WHERE room_id = $1 AND student_id = $2`,
            [room!.id, studentId],
            client
          );
          if (!hasSeat) {
            const cntRow = await queryOne<{ cnt: number }>(
              `SELECT COUNT(*)::int AS cnt FROM seats WHERE room_id = $1`,
              [room!.id],
              client
            );
            const cnt = Number(cntRow?.cnt ?? 0);
            const baris = Math.floor(cnt / 5) + 1;
            const kolom = (cnt % 5) + 1;
            const rowLetter = String.fromCharCode(64 + baris);
            const kodeKursi = `${rowLetter}${kolom}`;
            await execute(
              `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (room_id, kode_kursi) DO NOTHING`,
              [room!.id, kodeKursi, baris, kolom, kolom, baris, studentId],
              client
            );
          }
        }
      }
    } else if (params.docType === 'denah_peserta' || params.docType === 'pembagian_ruang') {
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

        let room = await queryOne<{ id: number; rows_count: number; cols_count: number }>(
          `SELECT id, rows_count, cols_count FROM rooms WHERE kode = $1`,
          [kodeRuang],
          client
        );
        if (!room) {
          room = await queryOne<{ id: number; rows_count: number; cols_count: number }>(
            `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, rows_count, cols_count`,
            [kodeRuang, namaRuang, kapasitas, Math.max(4, baris), Math.max(5, kolom)],
            client
          );
        } else {
          await execute(
            `UPDATE rooms
             SET rows_count = GREATEST(rows_count, $1),
                 cols_count = GREATEST(cols_count, $2),
                 kapasitas = GREATEST(kapasitas, $3)
             WHERE id = $4`,
            [baris, kolom, kapasitas, room.id],
            client
          );
        }

        let studentId: number | null = null;
        if (r.nomor_peserta) {
          const nomor = String(r.nomor_peserta).trim();
          const st = await queryOne<{ id: number }>(
            `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2`,
            [examId, nomor],
            client
          );
          if (st) {
            studentId = Number(st.id);
          } else if (r.nama) {
            const sr = await queryOne<{ id: number }>(
              `INSERT INTO students (exam_id, nomor_peserta, nama, kelas)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [examId, nomor, String(r.nama).trim(), r.kelas ? String(r.kelas).trim() : 'Umum'],
              client
            );
            studentId = Number(sr!.id);
          }
        }

        await execute(
          `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (room_id, kode_kursi) DO UPDATE SET
             baris = EXCLUDED.baris,
             kolom = EXCLUDED.kolom,
             posisi_x = EXCLUDED.posisi_x,
             posisi_y = EXCLUDED.posisi_y,
             student_id = COALESCE(EXCLUDED.student_id, seats.student_id)`,
          [room!.id, kodeKursi, baris, kolom, kolom, baris, studentId],
          client
        );
        inserted++;
      }
    } else if (params.docType === 'jadwal_ujian' || params.docType === 'jadwal_pengawasan') {
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

        let sess = await queryOne<{ id: number }>(
          `SELECT id FROM exam_sessions WHERE exam_id = $1 AND nama_sesi = $2 AND tanggal = $3`,
          [examId, namaSesi, tanggal],
          client
        );
        if (!sess) {
          sess = await queryOne<{ id: number }>(
            `INSERT INTO exam_sessions (exam_id, nama_sesi, tanggal, jam_mulai, jam_selesai)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [examId, namaSesi, tanggal, jamMulai, jamSelesai],
            client
          );
        }

        let subj = await queryOne<{ id: number }>(
          `SELECT id FROM subjects WHERE kode = $1 OR LOWER(nama) = LOWER($2)`,
          [kodeMapel, mapelNama],
          client
        );
        if (!subj) {
          subj = await queryOne<{ id: number }>(
            `INSERT INTO subjects (kode, nama) VALUES ($1, $2) RETURNING id`,
            [kodeMapel, mapelNama],
            client
          );
        }

        let room = await queryOne<{ id: number }>(
          `SELECT id FROM rooms WHERE kode = $1`,
          [kodeRuang],
          client
        );
        if (!room) {
          const namaRuang = r.nama_ruang ? String(r.nama_ruang).trim() : `Ruang ${kodeRuang}`;
          room = await queryOne<{ id: number }>(
            `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
             VALUES ($1, $2, 20, 4, 5)
             RETURNING id`,
            [kodeRuang, namaRuang],
            client
          );
        }

        let sched = await queryOne<{ id: number }>(
          `SELECT id FROM exam_schedules
           WHERE exam_session_id = $1 AND room_id = $2 AND tanggal = $3 AND jam_mulai = $4`,
          [sess!.id, room!.id, tanggal, jamMulai],
          client
        );
        if (!sched) {
          sched = await queryOne<{ id: number }>(
            `INSERT INTO exam_schedules (exam_session_id, subject_id, room_id, tanggal, jam_mulai, jam_selesai)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [sess!.id, subj!.id, room!.id, tanggal, jamMulai, jamSelesai],
            client
          );
          inserted++;
        } else {
          updated++;
        }

        const assignSupervisor = async (rawName: unknown, peran: 'utama' | 'pendamping') => {
          if (!rawName || String(rawName).trim() === '') return;
          const namaSup = String(rawName).trim();
          let sup = await queryOne<{ id: number }>(
            `SELECT id FROM supervisors WHERE LOWER(nama_lengkap) = LOWER($1)`,
            [namaSup],
            client
          );
          if (!sup) {
            sup = await queryOne<{ id: number }>(
              `INSERT INTO supervisors (nama_lengkap, status, created_at)
               VALUES ($1, 'active', $2)
               RETURNING id`,
              [namaSup, now],
              client
            );
          }
          await execute(
            `INSERT INTO supervision_assignments (supervisor_id, room_id, exam_session_id, exam_schedule_id, peran, status_jadwal)
             VALUES ($1, $2, $3, $4, $5, 'akan_datang')
             ON CONFLICT (supervisor_id, exam_schedule_id) DO UPDATE SET peran = EXCLUDED.peran`,
            [sup!.id, room!.id, sess!.id, sched!.id, peran],
            client
          );
        };

        await assignSupervisor(r.pengawas_utama, 'utama');
        await assignSupervisor(r.pengawas_pendamping, 'pendamping');
      }
    } else {
      inserted = params.rows.length;
    }

    await execute(
      `UPDATE import_batches
       SET exam_id = $1, detected_type = $2, extracted_json = $3, status = 'confirmed', confirmed_at = $4
       WHERE id = $5`,
      [examId, params.docType, JSON.stringify(params.rows), now, params.batchId],
      client
    );

    await markGeneratedDocumentsStale(examId, client);

    return { examId, inserted, updated, skipped };
  });
}
