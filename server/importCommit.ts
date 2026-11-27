import type { PoolClient } from 'pg';
import {
  ensureGeneratedDocRows,
  execute,
  markGeneratedDocumentsStale,
  queryOne,
  withTransaction,
} from './db.ts';
import type { ImportDocType, ImportSummaryReport } from '../src/types.ts';
import { getServerWibNow } from './time.ts';

function cleanStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function parseSeatCoords(meja: string, fallbackIndex: number): {
  kodeKursi: string;
  baris: number;
  kolom: number;
} {
  const m = meja.trim().toUpperCase().match(/^([A-Z])(\d+)$/);
  if (m) {
    const baris = Math.max(1, m[1].charCodeAt(0) - 64);
    const kolom = Math.max(1, Number(m[2]) || 1);
    return { kodeKursi: `${m[1]}${kolom}`, baris, kolom };
  }
  const numOnly = meja.trim().match(/^\d+$/);
  if (numOnly) {
    const n = Math.max(1, Number(numOnly[0]) || 1) - 1;
    const baris = Math.floor(n / 5) + 1;
    const kolom = (n % 5) + 1;
    const rowLetter = String.fromCharCode(64 + baris);
    return { kodeKursi: meja.trim(), baris, kolom };
  }
  const baris = Math.floor(fallbackIndex / 5) + 1;
  const kolom = (fallbackIndex % 5) + 1;
  return {
    kodeKursi: meja.trim() || `${String.fromCharCode(64 + baris)}${kolom}`,
    baris,
    kolom,
  };
}

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
}): Promise<ImportSummaryReport & { examId: number }> {
  const now = getServerWibNow().isoWib;

  return withTransaction(async (client) => {
    const examId = params.examId || (await ensureActiveExam(params.userId, client));
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let duplicatesCount = 0;
    let failedCount = 0;
    const failureReasons: Array<{ rowIndex: number; field?: string; value?: string; reason: string }> = [];

    if (params.docType === 'data_pengawas') {
      const seenNames = new Set<string>();
      const seenNips = new Set<string>();

      for (let i = 0; i < params.rows.length; i++) {
        const r = params.rows[i];
        const nama = cleanStr(r.nama_lengkap ?? r.nama);
        if (!nama) {
          failedCount++;
          failureReasons.push({
            rowIndex: i,
            field: 'nama_lengkap',
            reason: 'Nama pengawas kosong atau tidak terbaca',
          });
          continue;
        }
        const nip = cleanStr(r.nip_nuptk);
        const wa = cleanStr(r.whatsapp);
        const kode = cleanStr(r.kode_verifikasi);

        if ((nip && seenNips.has(nip)) || seenNames.has(nama.toLowerCase())) {
          duplicatesCount++;
          failureReasons.push({
            rowIndex: i,
            field: nip && seenNips.has(nip) ? 'nip_nuptk' : 'nama_lengkap',
            value: nip && seenNips.has(nip) ? nip : nama,
            reason: 'Duplikat data pengawas di dalam berkas impor',
          });
          continue;
        }
        if (nip) seenNips.add(nip);
        seenNames.add(nama.toLowerCase());

        const existing =
          (nip
            ? await queryOne<{
                id: number;
                nama_lengkap: string;
                whatsapp: string | null;
                kode_verifikasi: string | null;
              }>(
                `SELECT id, nama_lengkap, whatsapp, kode_verifikasi FROM supervisors WHERE nip_nuptk = $1`,
                [nip],
                client
              )
            : null) ||
          (await queryOne<{
            id: number;
            nama_lengkap: string;
            whatsapp: string | null;
            kode_verifikasi: string | null;
          }>(
            `SELECT id, nama_lengkap, whatsapp, kode_verifikasi FROM supervisors WHERE LOWER(nama_lengkap) = LOWER($1)`,
            [nama],
            client
          ));

        if (existing) {
          const nextWa = wa ?? existing.whatsapp;
          const nextKode = kode ?? existing.kode_verifikasi;
          const isUnchanged =
            cleanStr(existing.nama_lengkap) === nama &&
            cleanStr(existing.whatsapp) === cleanStr(nextWa) &&
            cleanStr(existing.kode_verifikasi) === cleanStr(nextKode);

          if (isUnchanged) {
            unchanged++;
          } else {
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
          }
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
      const seenNomor = new Set<string>();

      for (let i = 0; i < params.rows.length; i++) {
        const r = params.rows[i];
        const nomor = cleanStr(r.nomor_peserta);
        const nama = cleanStr(r.nama ?? r.nama_lengkap);
        const kelas = cleanStr(r.kelas);

        if (!nomor || !nama || (params.docType === 'data_peserta' && !kelas)) {
          failedCount++;
          const missingCols: string[] = [];
          if (!nomor) missingCols.push('nomor_peserta');
          if (!nama) missingCols.push('nama');
          if (params.docType === 'data_peserta' && !kelas) missingCols.push('kelas');
          failureReasons.push({
            rowIndex: i,
            field: missingCols.join(', '),
            value: nomor || nama || undefined,
            reason: `Kolom wajib (${missingCols.join(', ')}) kosong atau tidak terbaca`,
          });
          continue;
        }

        if (seenNomor.has(nomor)) {
          duplicatesCount++;
          failureReasons.push({
            rowIndex: i,
            field: 'nomor_peserta',
            value: nomor,
            reason: 'Duplikat Nomor Peserta dalam berkas yang sama',
          });
          continue;
        }
        seenNomor.add(nomor);

        const noUrut = cleanStr(r.no_urut);
        const nisn = cleanStr(r.nisn);
        const nis = cleanStr(r.nis);
        const jk = cleanStr(r.jk);
        const effectiveKelas = kelas || 'Umum';
        const userUjian = cleanStr(r.user_ujian);
        const passwordUjian = cleanStr(r.password_ujian);
        const sesi = cleanStr(r.sesi ?? r.nama_sesi);
        const ruang = cleanStr(r.ruang ?? r.kode_ruang);
        const meja = cleanStr(r.meja);
        const statusPeserta = cleanStr(r.status) || 'Aktif';

        let studentId: number;
        const existing = await queryOne<{
          id: number;
          no_urut: string | null;
          nisn: string | null;
          nis: string | null;
          nama: string;
          jk: string | null;
          kelas: string;
          user_ujian: string | null;
          password_ujian: string | null;
          sesi: string | null;
          ruang: string | null;
          meja: string | null;
          status: string | null;
        }>(
          `SELECT id, no_urut, nisn, nis, nama, jk, kelas, user_ujian, password_ujian, sesi, ruang, meja, status
           FROM students
           WHERE exam_id = $1 AND nomor_peserta = $2`,
          [examId, nomor],
          client
        );

        if (existing) {
          const nextNoUrut = noUrut ?? existing.no_urut;
          const nextNisn = nisn ?? existing.nisn;
          const nextNis = nis ?? existing.nis;
          const nextJk = jk ?? existing.jk;
          const nextUserUjian = userUjian ?? existing.user_ujian;
          const nextPassUjian = passwordUjian ?? existing.password_ujian;
          const nextSesi = sesi ?? existing.sesi;
          const nextRuang = ruang ?? existing.ruang;
          const nextMeja = meja ?? existing.meja;
          const nextStatus = statusPeserta || existing.status || 'Aktif';

          const isUnchanged =
            cleanStr(existing.no_urut) === cleanStr(nextNoUrut) &&
            cleanStr(existing.nisn) === cleanStr(nextNisn) &&
            cleanStr(existing.nis) === cleanStr(nextNis) &&
            cleanStr(existing.nama) === nama &&
            cleanStr(existing.jk) === cleanStr(nextJk) &&
            cleanStr(existing.kelas) === effectiveKelas &&
            cleanStr(existing.user_ujian) === cleanStr(nextUserUjian) &&
            cleanStr(existing.password_ujian) === cleanStr(nextPassUjian) &&
            cleanStr(existing.sesi) === cleanStr(nextSesi) &&
            cleanStr(existing.ruang) === cleanStr(nextRuang) &&
            cleanStr(existing.meja) === cleanStr(nextMeja) &&
            (cleanStr(existing.status) || 'Aktif') === nextStatus;

          studentId = Number(existing.id);
          if (isUnchanged) {
            unchanged++;
          } else {
            await execute(
              `UPDATE students
               SET no_urut = $1,
                   nisn = $2,
                   nis = $3,
                   nama = $4,
                   jk = $5,
                   kelas = $6,
                   user_ujian = $7,
                   password_ujian = $8,
                   sesi = $9,
                   ruang = $10,
                   meja = $11,
                   status = $12,
                   updated_at = $13
               WHERE id = $14`,
              [
                nextNoUrut,
                nextNisn,
                nextNis,
                nama,
                nextJk,
                effectiveKelas,
                nextUserUjian,
                nextPassUjian,
                nextSesi,
                nextRuang,
                nextMeja,
                nextStatus,
                now,
                studentId,
              ],
              client
            );
            updated++;
          }
        } else {
          const insertedStudent = await queryOne<{ id: number }>(
            `INSERT INTO students (
               exam_id, no_urut, nomor_peserta, nisn, nis, nama, jk, kelas,
               user_ujian, password_ujian, sesi, ruang, meja, status, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING id`,
            [
              examId,
              noUrut,
              nomor,
              nisn,
              nis,
              nama,
              jk,
              effectiveKelas,
              userUjian,
              passwordUjian,
              sesi,
              ruang,
              meja,
              statusPeserta,
              now,
            ],
            client
          );
          studentId = Number(insertedStudent!.id);
          inserted++;
        }

        const kodeRuang = ruang;
        if (kodeRuang) {
          let room = await queryOne<{ id: number }>(
            `SELECT id FROM rooms WHERE kode = $1`,
            [kodeRuang],
            client
          );
          if (!room) {
            const namaRuang = cleanStr(r.nama_ruang) || `Ruang ${kodeRuang}`;
            room = await queryOne<{ id: number }>(
              `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
               VALUES ($1, $2, 36, 6, 6)
               RETURNING id`,
              [kodeRuang, namaRuang],
              client
            );
          }

          const hasSeat = await queryOne<{ id: number; kode_kursi: string }>(
            `SELECT id, kode_kursi FROM seats WHERE room_id = $1 AND student_id = $2`,
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
            const seatInfo = meja
              ? parseSeatCoords(meja, cnt)
              : parseSeatCoords('', cnt);

            await execute(
              `UPDATE rooms
               SET rows_count = GREATEST(rows_count, $1),
                   cols_count = GREATEST(cols_count, $2)
               WHERE id = $3`,
              [seatInfo.baris, seatInfo.kolom, room!.id],
              client
            );

            await execute(
              `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (room_id, kode_kursi) DO UPDATE SET
                 student_id = COALESCE(seats.student_id, EXCLUDED.student_id)`,
              [
                room!.id,
                seatInfo.kodeKursi,
                seatInfo.baris,
                seatInfo.kolom,
                seatInfo.kolom,
                seatInfo.baris,
                studentId,
              ],
              client
            );
          }
        }
      }
    } else if (
      params.docType === 'denah_peserta' ||
      params.docType === 'pembagian_ruang' ||
      params.docType === 'denah_lingkungan'
    ) {
      const seenSeats = new Set<string>();

      for (let i = 0; i < params.rows.length; i++) {
        const r = params.rows[i];
        const kodeRuang = cleanStr(r.kode_ruang ?? r.ruang);
        if (!kodeRuang) {
          failedCount++;
          failureReasons.push({
            rowIndex: i,
            field: 'kode_ruang',
            reason: 'Kode ruang kosong atau tidak terbaca',
          });
          continue;
        }
        const namaRuang = cleanStr(r.nama_ruang) || `Ruang ${kodeRuang}`;
        const kapasitas = r.kapasitas ? Math.max(1, Number(r.kapasitas) || 20) : 20;
        const baris = Math.max(1, Number(r.baris) || Math.floor(i / 5) + 1);
        const kolom = Math.max(1, Number(r.kolom) || (i % 5) + 1);
        const kodeKursi =
          cleanStr(r.kode_kursi ?? r.meja) || `${String.fromCharCode(64 + baris)}${kolom}`;

        const seatKey = `${kodeRuang}|${kodeKursi}`;
        if (seenSeats.has(seatKey)) {
          duplicatesCount++;
          failureReasons.push({
            rowIndex: i,
            field: 'kode_kursi',
            value: seatKey,
            reason: 'Duplikat kursi pada ruang yang sama dalam berkas',
          });
          continue;
        }
        seenSeats.add(seatKey);

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
        const nomor = cleanStr(r.nomor_peserta);
        if (nomor) {
          const st = await queryOne<{ id: number }>(
            `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2`,
            [examId, nomor],
            client
          );
          if (st) {
            studentId = Number(st.id);
          } else if (cleanStr(r.nama ?? r.nama_lengkap)) {
            const sr = await queryOne<{ id: number }>(
              `INSERT INTO students (exam_id, nomor_peserta, nama, kelas, ruang, meja, status, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'Aktif', $7)
               RETURNING id`,
              [
                examId,
                nomor,
                cleanStr(r.nama ?? r.nama_lengkap)!,
                cleanStr(r.kelas) || 'Umum',
                kodeRuang,
                kodeKursi,
                now,
              ],
              client
            );
            studentId = Number(sr!.id);
          }
        }

        const existingSeat = await queryOne<{
          id: number;
          baris: number;
          kolom: number;
          student_id: number | null;
        }>(
          `SELECT id, baris, kolom, student_id FROM seats WHERE room_id = $1 AND kode_kursi = $2`,
          [room!.id, kodeKursi],
          client
        );

        if (existingSeat) {
          const nextStudentId = studentId ?? existingSeat.student_id;
          if (
            Number(existingSeat.baris) === baris &&
            Number(existingSeat.kolom) === kolom &&
            (existingSeat.student_id ? Number(existingSeat.student_id) : null) === nextStudentId
          ) {
            unchanged++;
          } else {
            await execute(
              `UPDATE seats SET baris = $1, kolom = $2, posisi_x = $3, posisi_y = $4, student_id = $5 WHERE id = $6`,
              [baris, kolom, kolom, baris, nextStudentId, existingSeat.id],
              client
            );
            updated++;
          }
        } else {
          await execute(
            `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [room!.id, kodeKursi, baris, kolom, kolom, baris, studentId],
            client
          );
          inserted++;
        }
      }
    } else if (params.docType === 'jadwal_ujian' || params.docType === 'jadwal_pengawasan') {
      const seenSlots = new Set<string>();

      for (let i = 0; i < params.rows.length; i++) {
        const r = params.rows[i];
        const tanggal = cleanStr(r.tanggal) || getServerWibNow().date;
        const jamMulai = cleanStr(r.jam_mulai);
        const jamSelesai = cleanStr(r.jam_selesai);
        const mapelNama = cleanStr(r.mata_pelajaran);
        const kodeRuang = cleanStr(r.kode_ruang ?? r.ruang);

        if (!jamMulai || !jamSelesai || !mapelNama || !kodeRuang) {
          failedCount++;
          const missing: string[] = [];
          if (!jamMulai) missing.push('jam_mulai');
          if (!jamSelesai) missing.push('jam_selesai');
          if (!mapelNama) missing.push('mata_pelajaran');
          if (!kodeRuang) missing.push('kode_ruang');
          failureReasons.push({
            rowIndex: i,
            field: missing.join(', '),
            reason: `Kolom wajib jadwal (${missing.join(', ')}) kosong atau tidak terbaca`,
          });
          continue;
        }

        const slotKey = `${kodeRuang}|${tanggal}|${jamMulai}`;
        if (seenSlots.has(slotKey)) {
          duplicatesCount++;
          failureReasons.push({
            rowIndex: i,
            field: 'kode_ruang',
            value: `${kodeRuang} (${tanggal} ${jamMulai})`,
            reason: 'Jadwal ruang & jam yang sama duplikat di dalam berkas',
          });
          continue;
        }
        seenSlots.add(slotKey);

        const namaSesi = cleanStr(r.nama_sesi ?? r.sesi) || 'Sesi 1';
        const kodeMapel =
          cleanStr(r.kode_mapel) ||
          mapelNama.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12);

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
          const namaRuang = cleanStr(r.nama_ruang) || `Ruang ${kodeRuang}`;
          room = await queryOne<{ id: number }>(
            `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
             VALUES ($1, $2, 20, 4, 5)
             RETURNING id`,
            [kodeRuang, namaRuang],
            client
          );
        }

        let sched = await queryOne<{ id: number; subject_id: number; jam_selesai: string }>(
          `SELECT id, subject_id, jam_selesai FROM exam_schedules
           WHERE exam_session_id = $1 AND room_id = $2 AND tanggal = $3 AND jam_mulai = $4`,
          [sess!.id, room!.id, tanggal, jamMulai],
          client
        );
        if (!sched) {
          sched = await queryOne<{ id: number; subject_id: number; jam_selesai: string }>(
            `INSERT INTO exam_schedules (exam_session_id, subject_id, room_id, tanggal, jam_mulai, jam_selesai)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, subject_id, jam_selesai`,
            [sess!.id, subj!.id, room!.id, tanggal, jamMulai, jamSelesai],
            client
          );
          inserted++;
        } else if (
          Number(sched.subject_id) === Number(subj!.id) &&
          String(sched.jam_selesai) === jamSelesai
        ) {
          unchanged++;
        } else {
          await execute(
            `UPDATE exam_schedules SET subject_id = $1, jam_selesai = $2 WHERE id = $3`,
            [subj!.id, jamSelesai, sched.id],
            client
          );
          updated++;
        }

        const assignSupervisor = async (rawName: unknown, peran: 'utama' | 'pendamping') => {
          const namaSup = cleanStr(rawName);
          if (!namaSup) return;
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
      // dokumen_pendukung (narrative/supporting archive): preserve archive cleanly without inventing structured rows
      unchanged = 0;
    }

    const parsedCount = inserted + updated + unchanged;
    const skippedCount = duplicatesCount + failedCount;
    const summary: ImportSummaryReport & { examId: number } = {
      examId,
      totalRows: params.rows.length,
      parsedCount,
      inserted,
      updated,
      unchanged,
      duplicatesCount,
      failedCount,
      skippedCount,
      failureReasons,
      archiveOnlyNote:
        params.docType === 'dokumen_pendukung'
          ? 'Dokumen pendukung disimpan sebagai arsip sumber tanpa fabrikasi baris terstruktur.'
          : null,
    };

    await execute(
      `UPDATE import_batches
       SET exam_id = $1,
           detected_type = $2,
           extracted_json = $3,
           summary_json = $4,
           status = 'confirmed',
           confirmed_at = $5
       WHERE id = $6`,
      [
        examId,
        params.docType,
        JSON.stringify(params.rows),
        JSON.stringify(summary),
        now,
        params.batchId,
      ],
      client
    );

    await markGeneratedDocumentsStale(examId, client);

    return summary;
  });
}
