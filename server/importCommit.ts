import type { PoolClient } from 'pg';
import {
  ensureGeneratedDocRows,
  execute,
  markGeneratedDocumentsStale,
  query,
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

      const existingSupervisors = await query<{
        id: number;
        nama_lengkap: string;
        nip_nuptk: string | null;
        whatsapp: string | null;
        kode_verifikasi: string | null;
      }>(
        `SELECT id, nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi FROM supervisors`,
        [],
        client
      );
      const byNip = new Map<string, (typeof existingSupervisors)[number]>();
      const byLowerName = new Map<string, (typeof existingSupervisors)[number]>();
      for (const s of existingSupervisors) {
        if (s.nip_nuptk) byNip.set(s.nip_nuptk.trim(), s);
        byLowerName.set(s.nama_lengkap.trim().toLowerCase(), s);
      }

      const toUpdate: Array<{ id: number; nama: string; wa: string | null; kode: string | null }> = [];
      const toInsert: Array<{
        nama: string;
        nip: string | null;
        wa: string | null;
        kode: string | null;
      }> = [];

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

        const existing = (nip ? byNip.get(nip) : undefined) || byLowerName.get(nama.toLowerCase());
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
            toUpdate.push({ id: Number(existing.id), nama, wa, kode });
            updated++;
          }
        } else {
          toInsert.push({ nama, nip, wa, kode });
          inserted++;
        }
      }

      if (toUpdate.length > 0) {
        await execute(
          `UPDATE supervisors AS s
           SET nama_lengkap = v.nama,
               whatsapp = COALESCE(v.wa, s.whatsapp),
               kode_verifikasi = COALESCE(v.kode, s.kode_verifikasi)
           FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[]) AS v(id, nama, wa, kode)
           WHERE s.id = v.id`,
          [
            toUpdate.map((u) => u.id),
            toUpdate.map((u) => u.nama),
            toUpdate.map((u) => u.wa),
            toUpdate.map((u) => u.kode),
          ],
          client
        );
      }

      if (toInsert.length > 0) {
        await execute(
          `INSERT INTO supervisors (nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi, status, created_at)
           SELECT v.nama, v.nip, v.wa, v.kode, 'active', $5
           FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS v(nama, nip, wa, kode)`,
          [
            toInsert.map((x) => x.nama),
            toInsert.map((x) => x.nip),
            toInsert.map((x) => x.wa),
            toInsert.map((x) => x.kode),
            now,
          ],
          client
        );
      }
    } else if (params.docType === 'data_peserta' || params.docType === 'daftar_hadir_peserta') {
      const seenNomor = new Set<string>();

      const existingStudents = await query<{
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
        nomor_peserta: string;
      }>(
        `SELECT id, no_urut, nisn, nis, nama, jk, kelas, user_ujian, password_ujian, sesi, ruang, meja, status, nomor_peserta
         FROM students
         WHERE exam_id = $1`,
        [examId],
        client
      );

      const studentByNomor = new Map<string, (typeof existingStudents)[number]>();
      const studentIdByNomor = new Map<string, number>();
      for (const st of existingStudents) {
        const key = String(st.nomor_peserta).trim();
        studentByNomor.set(key, st);
        studentIdByNomor.set(key, Number(st.id));
      }

      const existingRooms = await query<{
        id: number;
        kode: string;
        rows_count: number;
        cols_count: number;
      }>(`SELECT id, kode, rows_count, cols_count FROM rooms`, [], client);
      const roomByKode = new Map<string, { id: number; rows_count: number; cols_count: number }>();
      for (const rm of existingRooms) {
        roomByKode.set(String(rm.kode).trim(), {
          id: Number(rm.id),
          rows_count: Number(rm.rows_count),
          cols_count: Number(rm.cols_count),
        });
      }

      const existingSeats = await query<{
        id: number;
        room_id: number;
        kode_kursi: string;
        student_id: number | null;
      }>(`SELECT id, room_id, kode_kursi, student_id FROM seats`, [], client);

      const roomHasStudentSeat = new Set<string>();
      const seatCountByRoom = new Map<number, number>();
      const existingSeatStudentByRoomCode = new Map<string, number | null>();
      for (const seat of existingSeats) {
        const rId = Number(seat.room_id);
        seatCountByRoom.set(rId, (seatCountByRoom.get(rId) ?? 0) + 1);
        existingSeatStudentByRoomCode.set(
          `${rId}|${seat.kode_kursi}`,
          seat.student_id ? Number(seat.student_id) : null
        );
        if (seat.student_id) {
          roomHasStudentSeat.add(`${rId}|${Number(seat.student_id)}`);
        }
      }

      const studentsToUpdate: Array<{
        id: number;
        noUrut: string | null;
        nisn: string | null;
        nis: string | null;
        nama: string;
        jk: string | null;
        effectiveKelas: string;
        userUjian: string | null;
        passwordUjian: string | null;
        sesi: string | null;
        ruang: string | null;
        meja: string | null;
        statusPeserta: string;
      }> = [];

      const studentsToInsert: Array<{
        noUrut: string | null;
        nomor: string;
        nisn: string | null;
        nis: string | null;
        nama: string;
        jk: string | null;
        effectiveKelas: string;
        userUjian: string | null;
        passwordUjian: string | null;
        sesi: string | null;
        ruang: string | null;
        meja: string | null;
        statusPeserta: string;
      }> = [];

      const roomsToCreate = new Map<string, string>();
      const pendingSeatLinks: Array<{ nomor: string; kodeRuang: string; meja: string | null }> = [];

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

        const existing = studentByNomor.get(nomor);
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

          if (isUnchanged) {
            unchanged++;
          } else {
            studentsToUpdate.push({
              id: Number(existing.id),
              noUrut: nextNoUrut,
              nisn: nextNisn,
              nis: nextNis,
              nama,
              jk: nextJk,
              effectiveKelas,
              userUjian: nextUserUjian,
              passwordUjian: nextPassUjian,
              sesi: nextSesi,
              ruang: nextRuang,
              meja: nextMeja,
              statusPeserta: nextStatus,
            });
            updated++;
          }
        } else {
          studentsToInsert.push({
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
          });
          inserted++;
        }

        if (ruang) {
          if (!roomByKode.has(ruang) && !roomsToCreate.has(ruang)) {
            roomsToCreate.set(ruang, cleanStr(r.nama_ruang) || `Ruang ${ruang}`);
          }
          pendingSeatLinks.push({ nomor, kodeRuang: ruang, meja });
        }
      }

      if (roomsToCreate.size > 0) {
        const roomCodes = Array.from(roomsToCreate.keys());
        const roomNames = roomCodes.map((k) => roomsToCreate.get(k)!);
        const insertedRooms = await query<{
          id: number;
          kode: string;
          rows_count: number;
          cols_count: number;
        }>(
          `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
           SELECT v.kode, v.nama, 36, 6, 6
           FROM UNNEST($1::text[], $2::text[]) AS v(kode, nama)
           ON CONFLICT (kode) DO NOTHING
           RETURNING id, kode, rows_count, cols_count`,
          [roomCodes, roomNames],
          client
        );
        for (const rm of insertedRooms) {
          roomByKode.set(String(rm.kode).trim(), {
            id: Number(rm.id),
            rows_count: Number(rm.rows_count),
            cols_count: Number(rm.cols_count),
          });
        }
      }

      if (studentsToUpdate.length > 0) {
        await execute(
          `UPDATE students AS s
           SET no_urut = v.no_urut,
               nisn = v.nisn,
               nis = v.nis,
               nama = v.nama,
               jk = v.jk,
               kelas = v.kelas,
               user_ujian = v.user_ujian,
               password_ujian = v.password_ujian,
               sesi = v.sesi,
               ruang = v.ruang,
               meja = v.meja,
               status = v.status,
               updated_at = $14
           FROM UNNEST(
             $1::int[],
             $2::text[],
             $3::text[],
             $4::text[],
             $5::text[],
             $6::text[],
             $7::text[],
             $8::text[],
             $9::text[],
             $10::text[],
             $11::text[],
             $12::text[],
             $13::text[]
           ) AS v(
             id, no_urut, nisn, nis, nama, jk, kelas,
             user_ujian, password_ujian, sesi, ruang, meja, status
           )
           WHERE s.id = v.id`,
          [
            studentsToUpdate.map((u) => u.id),
            studentsToUpdate.map((u) => u.noUrut),
            studentsToUpdate.map((u) => u.nisn),
            studentsToUpdate.map((u) => u.nis),
            studentsToUpdate.map((u) => u.nama),
            studentsToUpdate.map((u) => u.jk),
            studentsToUpdate.map((u) => u.effectiveKelas),
            studentsToUpdate.map((u) => u.userUjian),
            studentsToUpdate.map((u) => u.passwordUjian),
            studentsToUpdate.map((u) => u.sesi),
            studentsToUpdate.map((u) => u.ruang),
            studentsToUpdate.map((u) => u.meja),
            studentsToUpdate.map((u) => u.statusPeserta),
            now,
          ],
          client
        );
      }

      if (studentsToInsert.length > 0) {
        const insertedRows = await query<{ id: number; nomor_peserta: string }>(
          `INSERT INTO students (
             exam_id, no_urut, nomor_peserta, nisn, nis, nama, jk, kelas,
             user_ujian, password_ujian, sesi, ruang, meja, status, updated_at
           )
           SELECT
             $1, v.no_urut, v.nomor_peserta, v.nisn, v.nis, v.nama, v.jk, v.kelas,
             v.user_ujian, v.password_ujian, v.sesi, v.ruang, v.meja, v.status, $15
           FROM UNNEST(
             $2::text[],
             $3::text[],
             $4::text[],
             $5::text[],
             $6::text[],
             $7::text[],
             $8::text[],
             $9::text[],
             $10::text[],
             $11::text[],
             $12::text[],
             $13::text[],
             $14::text[]
           ) AS v(
             no_urut, nomor_peserta, nisn, nis, nama, jk, kelas,
             user_ujian, password_ujian, sesi, ruang, meja, status
           )
           RETURNING id, nomor_peserta`,
          [
            examId,
            studentsToInsert.map((s) => s.noUrut),
            studentsToInsert.map((s) => s.nomor),
            studentsToInsert.map((s) => s.nisn),
            studentsToInsert.map((s) => s.nis),
            studentsToInsert.map((s) => s.nama),
            studentsToInsert.map((s) => s.jk),
            studentsToInsert.map((s) => s.effectiveKelas),
            studentsToInsert.map((s) => s.userUjian),
            studentsToInsert.map((s) => s.passwordUjian),
            studentsToInsert.map((s) => s.sesi),
            studentsToInsert.map((s) => s.ruang),
            studentsToInsert.map((s) => s.meja),
            studentsToInsert.map((s) => s.statusPeserta),
            now,
          ],
          client
        );
        for (const row of insertedRows) {
          studentIdByNomor.set(String(row.nomor_peserta).trim(), Number(row.id));
        }
      }

      if (pendingSeatLinks.length > 0) {
        const roomBounds = new Map<number, { rows: number; cols: number }>();
        const seatUpsertMap = new Map<
          string,
          { roomId: number; kodeKursi: string; baris: number; kolom: number; studentId: number }
        >();

        for (const link of pendingSeatLinks) {
          const room = roomByKode.get(link.kodeRuang);
          const studentId = studentIdByNomor.get(link.nomor);
          if (!room || !studentId) continue;

          const studentRoomKey = `${room.id}|${studentId}`;
          if (roomHasStudentSeat.has(studentRoomKey)) continue;
          roomHasStudentSeat.add(studentRoomKey);

          const cnt = seatCountByRoom.get(room.id) ?? 0;
          const seatInfo = link.meja
            ? parseSeatCoords(link.meja, cnt)
            : parseSeatCoords('', cnt);

          const seatCodeKey = `${room.id}|${seatInfo.kodeKursi}`;
          if (!existingSeatStudentByRoomCode.has(seatCodeKey)) {
            seatCountByRoom.set(room.id, cnt + 1);
            existingSeatStudentByRoomCode.set(seatCodeKey, studentId);
          }

          const prevBound = roomBounds.get(room.id) ?? {
            rows: room.rows_count,
            cols: room.cols_count,
          };
          if (seatInfo.baris > prevBound.rows || seatInfo.kolom > prevBound.cols) {
            roomBounds.set(room.id, {
              rows: Math.max(prevBound.rows, seatInfo.baris),
              cols: Math.max(prevBound.cols, seatInfo.kolom),
            });
          }

          if (!seatUpsertMap.has(seatCodeKey)) {
            seatUpsertMap.set(seatCodeKey, {
              roomId: room.id,
              kodeKursi: seatInfo.kodeKursi,
              baris: seatInfo.baris,
              kolom: seatInfo.kolom,
              studentId,
            });
          }
        }

        if (roomBounds.size > 0) {
          const entries = Array.from(roomBounds.entries());
          await execute(
            `UPDATE rooms AS r
             SET rows_count = GREATEST(r.rows_count, v.rows_count),
                 cols_count = GREATEST(r.cols_count, v.cols_count)
             FROM UNNEST($1::int[], $2::int[], $3::int[]) AS v(id, rows_count, cols_count)
             WHERE r.id = v.id`,
            [
              entries.map(([id]) => id),
              entries.map(([, b]) => b.rows),
              entries.map(([, b]) => b.cols),
            ],
            client
          );
        }

        const seatsToUpsert = Array.from(seatUpsertMap.values());
        if (seatsToUpsert.length > 0) {
          await execute(
            `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
             SELECT v.room_id, v.kode_kursi, v.baris, v.kolom, v.kolom, v.baris, v.student_id
             FROM UNNEST($1::int[], $2::text[], $3::int[], $4::int[], $5::int[]) AS v(
               room_id, kode_kursi, baris, kolom, student_id
             )
             ON CONFLICT (room_id, kode_kursi) DO UPDATE SET
               student_id = COALESCE(seats.student_id, EXCLUDED.student_id)`,
            [
              seatsToUpsert.map((s) => s.roomId),
              seatsToUpsert.map((s) => s.kodeKursi),
              seatsToUpsert.map((s) => s.baris),
              seatsToUpsert.map((s) => s.kolom),
              seatsToUpsert.map((s) => s.studentId),
            ],
            client
          );
        }
      }
    } else if (
      params.docType === 'denah_peserta' ||
      params.docType === 'pembagian_ruang' ||
      params.docType === 'denah_lingkungan'
    ) {
      const seenSeats = new Set<string>();

      const existingRooms = await query<{
        id: number;
        kode: string;
        rows_count: number;
        cols_count: number;
        kapasitas: number;
      }>(`SELECT id, kode, rows_count, cols_count, kapasitas FROM rooms`, [], client);
      const roomByKode = new Map<
        string,
        { id: number; rows_count: number; cols_count: number; kapasitas: number }
      >();
      for (const rm of existingRooms) {
        roomByKode.set(String(rm.kode).trim(), {
          id: Number(rm.id),
          rows_count: Number(rm.rows_count),
          cols_count: Number(rm.cols_count),
          kapasitas: Number(rm.kapasitas),
        });
      }

      const existingStudents = await query<{ id: number; nomor_peserta: string }>(
        `SELECT id, nomor_peserta FROM students WHERE exam_id = $1`,
        [examId],
        client
      );
      const studentIdByNomor = new Map<string, number>();
      for (const st of existingStudents) {
        studentIdByNomor.set(String(st.nomor_peserta).trim(), Number(st.id));
      }

      const existingSeats = await query<{
        id: number;
        room_id: number;
        kode_kursi: string;
        baris: number;
        kolom: number;
        student_id: number | null;
      }>(`SELECT id, room_id, kode_kursi, baris, kolom, student_id FROM seats`, [], client);
      const seatByKey = new Map<string, (typeof existingSeats)[number]>();
      for (const seat of existingSeats) {
        seatByKey.set(`${Number(seat.room_id)}|${seat.kode_kursi}`, seat);
      }

      const validRows: Array<{
        kodeRuang: string;
        namaRuang: string;
        kapasitas: number;
        baris: number;
        kolom: number;
        kodeKursi: string;
        nomor: string | null;
        namaPeserta: string | null;
        kelasPeserta: string | null;
      }> = [];

      const roomsToCreate = new Map<
        string,
        { nama: string; kapasitas: number; rows: number; cols: number }
      >();
      const studentsToCreate = new Map<
        string,
        { nomor: string; nama: string; kelas: string; ruang: string; meja: string }
      >();

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

        const nomor = cleanStr(r.nomor_peserta);
        const namaPeserta = cleanStr(r.nama ?? r.nama_lengkap);
        const kelasPeserta = cleanStr(r.kelas) || 'Umum';

        if (!roomByKode.has(kodeRuang)) {
          const prev = roomsToCreate.get(kodeRuang);
          roomsToCreate.set(kodeRuang, {
            nama: prev?.nama || namaRuang,
            kapasitas: Math.max(prev?.kapasitas ?? 0, kapasitas),
            rows: Math.max(prev?.rows ?? 4, baris),
            cols: Math.max(prev?.cols ?? 5, kolom),
          });
        }

        if (nomor && !studentIdByNomor.has(nomor) && namaPeserta && !studentsToCreate.has(nomor)) {
          studentsToCreate.set(nomor, {
            nomor,
            nama: namaPeserta,
            kelas: kelasPeserta,
            ruang: kodeRuang,
            meja: kodeKursi,
          });
        }

        validRows.push({
          kodeRuang,
          namaRuang,
          kapasitas,
          baris,
          kolom,
          kodeKursi,
          nomor,
          namaPeserta,
          kelasPeserta,
        });
      }

      if (roomsToCreate.size > 0) {
        const codes = Array.from(roomsToCreate.keys());
        const createdRooms = await query<{
          id: number;
          kode: string;
          rows_count: number;
          cols_count: number;
          kapasitas: number;
        }>(
          `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
           SELECT v.kode, v.nama, v.kapasitas, v.rows_count, v.cols_count
           FROM UNNEST($1::text[], $2::text[], $3::int[], $4::int[], $5::int[]) AS v(
             kode, nama, kapasitas, rows_count, cols_count
           )
           ON CONFLICT (kode) DO NOTHING
           RETURNING id, kode, rows_count, cols_count, kapasitas`,
          [
            codes,
            codes.map((c) => roomsToCreate.get(c)!.nama),
            codes.map((c) => roomsToCreate.get(c)!.kapasitas),
            codes.map((c) => roomsToCreate.get(c)!.rows),
            codes.map((c) => roomsToCreate.get(c)!.cols),
          ],
          client
        );
        for (const rm of createdRooms) {
          roomByKode.set(String(rm.kode).trim(), {
            id: Number(rm.id),
            rows_count: Number(rm.rows_count),
            cols_count: Number(rm.cols_count),
            kapasitas: Number(rm.kapasitas),
          });
        }
      }

      if (studentsToCreate.size > 0) {
        const list = Array.from(studentsToCreate.values());
        const createdStudents = await query<{ id: number; nomor_peserta: string }>(
          `INSERT INTO students (exam_id, nomor_peserta, nama, kelas, ruang, meja, status, updated_at)
           SELECT $1, v.nomor, v.nama, v.kelas, v.ruang, v.meja, 'Aktif', $7
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS v(
             nomor, nama, kelas, ruang, meja
           )
           RETURNING id, nomor_peserta`,
          [
            examId,
            list.map((s) => s.nomor),
            list.map((s) => s.nama),
            list.map((s) => s.kelas),
            list.map((s) => s.ruang),
            list.map((s) => s.meja),
            now,
          ],
          client
        );
        for (const st of createdStudents) {
          studentIdByNomor.set(String(st.nomor_peserta).trim(), Number(st.id));
        }
      }

      const roomUpdates = new Map<number, { rows: number; cols: number; kapasitas: number }>();
      const seatsToUpdate: Array<{
        id: number;
        baris: number;
        kolom: number;
        studentId: number | null;
      }> = [];
      const seatsToInsert: Array<{
        roomId: number;
        kodeKursi: string;
        baris: number;
        kolom: number;
        studentId: number | null;
      }> = [];

      for (const vr of validRows) {
        const room = roomByKode.get(vr.kodeRuang);
        if (!room) continue;

        const prevR = roomUpdates.get(room.id) ?? {
          rows: room.rows_count,
          cols: room.cols_count,
          kapasitas: room.kapasitas,
        };
        if (vr.baris > prevR.rows || vr.kolom > prevR.cols || vr.kapasitas > prevR.kapasitas) {
          roomUpdates.set(room.id, {
            rows: Math.max(prevR.rows, vr.baris),
            cols: Math.max(prevR.cols, vr.kolom),
            kapasitas: Math.max(prevR.kapasitas, vr.kapasitas),
          });
        }

        const studentId = vr.nomor ? studentIdByNomor.get(vr.nomor) ?? null : null;
        const existingSeat = seatByKey.get(`${room.id}|${vr.kodeKursi}`);
        if (existingSeat) {
          const nextStudentId = studentId ?? (existingSeat.student_id ? Number(existingSeat.student_id) : null);
          if (
            Number(existingSeat.baris) === vr.baris &&
            Number(existingSeat.kolom) === vr.kolom &&
            (existingSeat.student_id ? Number(existingSeat.student_id) : null) === nextStudentId
          ) {
            unchanged++;
          } else {
            seatsToUpdate.push({
              id: Number(existingSeat.id),
              baris: vr.baris,
              kolom: vr.kolom,
              studentId: nextStudentId,
            });
            updated++;
          }
        } else {
          seatsToInsert.push({
            roomId: room.id,
            kodeKursi: vr.kodeKursi,
            baris: vr.baris,
            kolom: vr.kolom,
            studentId,
          });
          inserted++;
        }
      }

      if (roomUpdates.size > 0) {
        const entries = Array.from(roomUpdates.entries());
        await execute(
          `UPDATE rooms AS r
           SET rows_count = GREATEST(r.rows_count, v.rows_count),
               cols_count = GREATEST(r.cols_count, v.cols_count),
               kapasitas = GREATEST(r.kapasitas, v.kapasitas)
           FROM UNNEST($1::int[], $2::int[], $3::int[], $4::int[]) AS v(id, rows_count, cols_count, kapasitas)
           WHERE r.id = v.id`,
          [
            entries.map(([id]) => id),
            entries.map(([, u]) => u.rows),
            entries.map(([, u]) => u.cols),
            entries.map(([, u]) => u.kapasitas),
          ],
          client
        );
      }

      if (seatsToUpdate.length > 0) {
        await execute(
          `UPDATE seats AS s
           SET baris = v.baris,
               kolom = v.kolom,
               posisi_x = v.kolom,
               posisi_y = v.baris,
               student_id = v.student_id
           FROM UNNEST($1::int[], $2::int[], $3::int[], $4::int[]) AS v(id, baris, kolom, student_id)
           WHERE s.id = v.id`,
          [
            seatsToUpdate.map((s) => s.id),
            seatsToUpdate.map((s) => s.baris),
            seatsToUpdate.map((s) => s.kolom),
            seatsToUpdate.map((s) => s.studentId),
          ],
          client
        );
      }

      if (seatsToInsert.length > 0) {
        await execute(
          `INSERT INTO seats (room_id, kode_kursi, baris, kolom, posisi_x, posisi_y, student_id)
           SELECT v.room_id, v.kode_kursi, v.baris, v.kolom, v.kolom, v.baris, v.student_id
           FROM UNNEST($1::int[], $2::text[], $3::int[], $4::int[], $5::int[]) AS v(
             room_id, kode_kursi, baris, kolom, student_id
           )`,
          [
            seatsToInsert.map((s) => s.roomId),
            seatsToInsert.map((s) => s.kodeKursi),
            seatsToInsert.map((s) => s.baris),
            seatsToInsert.map((s) => s.kolom),
            seatsToInsert.map((s) => s.studentId),
          ],
          client
        );
      }
    } else if (params.docType === 'jadwal_ujian' || params.docType === 'jadwal_pengawasan') {
      const seenSlots = new Set<string>();

      const existingSessions = await query<{ id: number; nama_sesi: string; tanggal: string }>(
        `SELECT id, nama_sesi, tanggal FROM exam_sessions WHERE exam_id = $1`,
        [examId],
        client
      );
      const sessionByKey = new Map<string, number>();
      for (const s of existingSessions) {
        sessionByKey.set(`${s.nama_sesi}|${s.tanggal}`, Number(s.id));
      }

      const existingSubjects = await query<{ id: number; kode: string; nama: string }>(
        `SELECT id, kode, nama FROM subjects`,
        [],
        client
      );
      const subjectByCode = new Map<string, number>();
      const subjectByLowerName = new Map<string, number>();
      for (const sb of existingSubjects) {
        subjectByCode.set(sb.kode, Number(sb.id));
        subjectByLowerName.set(sb.nama.trim().toLowerCase(), Number(sb.id));
      }

      const existingRooms = await query<{ id: number; kode: string }>(
        `SELECT id, kode FROM rooms`,
        [],
        client
      );
      const roomByKode = new Map<string, number>();
      for (const rm of existingRooms) {
        roomByKode.set(String(rm.kode).trim(), Number(rm.id));
      }

      const existingSchedules = await query<{
        id: number;
        exam_session_id: number;
        room_id: number;
        tanggal: string;
        jam_mulai: string;
        subject_id: number;
        jam_selesai: string;
      }>(
        `SELECT id, exam_session_id, room_id, tanggal, jam_mulai, subject_id, jam_selesai FROM exam_schedules`,
        [],
        client
      );
      const scheduleByKey = new Map<string, (typeof existingSchedules)[number]>();
      for (const sc of existingSchedules) {
        scheduleByKey.set(
          `${Number(sc.exam_session_id)}|${Number(sc.room_id)}|${sc.tanggal}|${sc.jam_mulai}`,
          sc
        );
      }

      const existingSupervisors = await query<{ id: number; nama_lengkap: string }>(
        `SELECT id, nama_lengkap FROM supervisors`,
        [],
        client
      );
      const supervisorByLowerName = new Map<string, number>();
      for (const sp of existingSupervisors) {
        supervisorByLowerName.set(sp.nama_lengkap.trim().toLowerCase(), Number(sp.id));
      }

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

        const sessKey = `${namaSesi}|${tanggal}`;
        let sessId = sessionByKey.get(sessKey);
        if (!sessId) {
          const insertedSess = await queryOne<{ id: number }>(
            `INSERT INTO exam_sessions (exam_id, nama_sesi, tanggal, jam_mulai, jam_selesai)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [examId, namaSesi, tanggal, jamMulai, jamSelesai],
            client
          );
          sessId = Number(insertedSess!.id);
          sessionByKey.set(sessKey, sessId);
        }

        let subjId = subjectByCode.get(kodeMapel) ?? subjectByLowerName.get(mapelNama.toLowerCase());
        if (!subjId) {
          const insertedSubj = await queryOne<{ id: number }>(
            `INSERT INTO subjects (kode, nama) VALUES ($1, $2) RETURNING id`,
            [kodeMapel, mapelNama],
            client
          );
          subjId = Number(insertedSubj!.id);
          subjectByCode.set(kodeMapel, subjId);
          subjectByLowerName.set(mapelNama.toLowerCase(), subjId);
        }

        let roomId = roomByKode.get(kodeRuang);
        if (!roomId) {
          const namaRuang = cleanStr(r.nama_ruang) || `Ruang ${kodeRuang}`;
          const insertedRoom = await queryOne<{ id: number }>(
            `INSERT INTO rooms (kode, nama, kapasitas, rows_count, cols_count)
             VALUES ($1, $2, 20, 4, 5)
             RETURNING id`,
            [kodeRuang, namaRuang],
            client
          );
          roomId = Number(insertedRoom!.id);
          roomByKode.set(kodeRuang, roomId);
        }

        const schedKey = `${sessId}|${roomId}|${tanggal}|${jamMulai}`;
        const existingSched = scheduleByKey.get(schedKey);
        let schedId: number;
        if (!existingSched) {
          const insertedSched = await queryOne<{ id: number }>(
            `INSERT INTO exam_schedules (exam_session_id, subject_id, room_id, tanggal, jam_mulai, jam_selesai)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [sessId, subjId, roomId, tanggal, jamMulai, jamSelesai],
            client
          );
          schedId = Number(insertedSched!.id);
          scheduleByKey.set(schedKey, {
            id: schedId,
            exam_session_id: sessId,
            room_id: roomId,
            tanggal,
            jam_mulai: jamMulai,
            subject_id: subjId,
            jam_selesai: jamSelesai,
          });
          inserted++;
        } else {
          schedId = Number(existingSched.id);
          if (
            Number(existingSched.subject_id) === subjId &&
            String(existingSched.jam_selesai) === jamSelesai
          ) {
            unchanged++;
          } else {
            await execute(
              `UPDATE exam_schedules SET subject_id = $1, jam_selesai = $2 WHERE id = $3`,
              [subjId, jamSelesai, schedId],
              client
            );
            existingSched.subject_id = subjId;
            existingSched.jam_selesai = jamSelesai;
            updated++;
          }
        }

        const assignSupervisor = async (rawName: unknown, peran: 'utama' | 'pendamping') => {
          const namaSup = cleanStr(rawName);
          if (!namaSup) return;
          let supId = supervisorByLowerName.get(namaSup.toLowerCase());
          if (!supId) {
            const insertedSup = await queryOne<{ id: number }>(
              `INSERT INTO supervisors (nama_lengkap, status, created_at)
               VALUES ($1, 'active', $2)
               RETURNING id`,
              [namaSup, now],
              client
            );
            supId = Number(insertedSup!.id);
            supervisorByLowerName.set(namaSup.toLowerCase(), supId);
          }
          await execute(
            `INSERT INTO supervision_assignments (supervisor_id, room_id, exam_session_id, exam_schedule_id, peran, status_jadwal)
             VALUES ($1, $2, $3, $4, $5, 'akan_datang')
             ON CONFLICT (supervisor_id, exam_schedule_id) DO UPDATE SET peran = EXCLUDED.peran`,
            [supId, roomId, sessId, schedId, peran],
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
