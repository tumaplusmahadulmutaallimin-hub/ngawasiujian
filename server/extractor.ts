import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import * as XLSX from 'xlsx';
import type {
  ImportDocType,
  ImportPageLog,
  ImportRowIssue,
  ImportSummaryReport,
} from '../src/types.ts';
import { isDatabaseConfigured, query, queryOne } from './db.ts';
import { getServerWibNow } from './time.ts';

export interface ExtractionResult {
  detected_type: ImportDocType;
  confidence: number;
  rows: Array<Record<string, unknown>>;
  unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }>;
  duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }>;
  page_logs: ImportPageLog[];
  row_issues: ImportRowIssue[];
  summary: ImportSummaryReport;
}

const VALID_DOC_TYPES: ImportDocType[] = [
  'data_peserta',
  'data_pengawas',
  'jadwal_ujian',
  'jadwal_pengawasan',
  'pembagian_ruang',
  'denah_peserta',
  'daftar_hadir_peserta',
  'denah_lingkungan',
  'dokumen_pendukung',
];

export const DNPU_COLUMNS_ORDER = [
  'no_urut',
  'nisn',
  'nis',
  'nama',
  'jk',
  'kelas',
  'nomor_peserta',
  'user_ujian',
  'password_ujian',
  'sesi',
  'ruang',
  'meja',
  'status',
] as const;

function normalizeHeaderKey(raw: string, targetType?: ImportDocType | null): string {
  const k = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const isPesertaContext =
    targetType === 'data_peserta' || targetType === 'daftar_hadir_peserta';
  const isPengawasContext = targetType === 'data_pengawas';

  const aliasMap: Record<string, string> = {
    no: 'no_urut',
    no_urut: 'no_urut',
    nomor: 'no_urut',
    nisn: 'nisn',
    nis: 'nis',
    no_peserta: 'nomor_peserta',
    nomor_peserta: 'nomor_peserta',
    nomor_ujian: 'nomor_peserta',
    id_peserta: 'nomor_peserta',
    nama_peserta: 'nama',
    nama_siswa: 'nama',
    nama_lengkap: isPesertaContext ? 'nama' : isPengawasContext ? 'nama_lengkap' : 'nama_lengkap',
    jk: 'jk',
    j_k: 'jk',
    jenis_kelamin: 'jk',
    kelamin: 'jk',
    l_p: 'jk',
    kelas: 'kelas',
    rombel: 'kelas',
    tingkat_kelas: 'kelas',
    user_ujian: 'user_ujian',
    username_ujian: 'user_ujian',
    user: 'user_ujian',
    password_ujian: 'password_ujian',
    pass_ujian: 'password_ujian',
    sandi_ujian: 'password_ujian',
    password: 'password_ujian',
    sesi: isPesertaContext ? 'sesi' : 'nama_sesi',
    sesi_ujian: isPesertaContext ? 'sesi' : 'nama_sesi',
    nama_sesi: isPesertaContext ? 'sesi' : 'nama_sesi',
    ruang: isPesertaContext ? 'ruang' : 'kode_ruang',
    ruangan: isPesertaContext ? 'ruang' : 'kode_ruang',
    kode_ruang: isPesertaContext ? 'ruang' : 'kode_ruang',
    kode_ruangan: isPesertaContext ? 'ruang' : 'kode_ruang',
    nama_ruangan: 'nama_ruang',
    meja: 'meja',
    no_meja: 'meja',
    nomor_meja: 'meja',
    status: 'status',
    status_peserta: 'status',
    nama_pengawas: 'nama_lengkap',
    pengawas: 'nama_lengkap',
    nip: 'nip_nuptk',
    nuptk: 'nip_nuptk',
    nip_nuptk: 'nip_nuptk',
    no_wa: 'whatsapp',
    no_hp: 'whatsapp',
    hp: 'whatsapp',
    kode_verifikasi: 'kode_verifikasi',
    pin_verifikasi: 'kode_verifikasi',
    kursi: 'kode_kursi',
    no_kursi: 'kode_kursi',
    nomor_kursi: 'kode_kursi',
    row: 'baris',
    col: 'kolom',
    mapel: 'mata_pelajaran',
    nama_mapel: 'mata_pelajaran',
    kode_mapel: 'kode_mapel',
    mulai: 'jam_mulai',
    waktu_mulai: 'jam_mulai',
    selesai: 'jam_selesai',
    waktu_selesai: 'jam_selesai',
    tgl: 'tanggal',
    tanggal_ujian: 'tanggal',
    pengawas_1: 'pengawas_utama',
    pengawas_utama: 'pengawas_utama',
    pengawas_2: 'pengawas_pendamping',
    pengawas_pendamping: 'pengawas_pendamping',
  };

  return aliasMap[k] || k;
}

function classifyByHeaders(
  headers: string[],
  targetType?: ImportDocType | null
): { type: ImportDocType; confidence: number } {
  const set = new Set(headers);
  if (
    set.has('nomor_peserta') &&
    (set.has('nisn') ||
      set.has('nis') ||
      set.has('user_ujian') ||
      set.has('password_ujian') ||
      set.has('meja') ||
      set.has('nama'))
  ) {
    if (set.has('kode_kursi') || (set.has('baris') && set.has('kolom'))) {
      return { type: 'denah_peserta', confidence: 0.95 };
    }
    return { type: 'data_peserta', confidence: 0.98 };
  }
  if (set.has('kode_kursi') || (set.has('baris') && set.has('kolom'))) {
    return { type: 'denah_peserta', confidence: 0.94 };
  }
  if (set.has('nomor_peserta') && (set.has('nama') || set.has('nama_lengkap') || set.has('nisn'))) {
    if (set.has('kode_ruang') && !set.has('kelas')) {
      return { type: 'pembagian_ruang', confidence: 0.88 };
    }
    return { type: 'data_peserta', confidence: 0.95 };
  }
  if ((set.has('nama_lengkap') || set.has('nip_nuptk')) && !set.has('mata_pelajaran') && !set.has('nomor_peserta')) {
    return { type: 'data_pengawas', confidence: 0.92 };
  }
  if (set.has('mata_pelajaran') && (set.has('pengawas_utama') || set.has('pengawas_pendamping'))) {
    return { type: 'jadwal_pengawasan', confidence: 0.94 };
  }
  if (set.has('mata_pelajaran') && set.has('tanggal') && set.has('jam_mulai')) {
    return { type: 'jadwal_ujian', confidence: 0.9 };
  }
  if ((set.has('kode_ruang') || set.has('ruang')) && set.has('kapasitas')) {
    return { type: 'pembagian_ruang', confidence: 0.85 };
  }
  if (targetType) {
    return { type: targetType, confidence: 0.65 };
  }
  return { type: 'dokumen_pendukung', confidence: 0.52 };
}

function finalizeRowsForType(
  rows: Array<Record<string, unknown>>,
  docType: ImportDocType
): Array<Record<string, unknown>> {
  const isPeserta = docType === 'data_peserta' || docType === 'daftar_hadir_peserta';
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    if (isPeserta) {
      if ((out.nama === null || out.nama === undefined || String(out.nama).trim() === '') && out.nama_lengkap) {
        out.nama = out.nama_lengkap;
        delete out.nama_lengkap;
      }
      if ((out.ruang === null || out.ruang === undefined || String(out.ruang).trim() === '') && out.kode_ruang) {
        out.ruang = out.kode_ruang;
      }
      if ((out.sesi === null || out.sesi === undefined || String(out.sesi).trim() === '') && out.nama_sesi) {
        out.sesi = out.nama_sesi;
      }
      // Preserve ID fields strictly as string
      for (const strField of [
        'no_urut',
        'nisn',
        'nis',
        'nomor_peserta',
        'user_ujian',
        'password_ujian',
        'sesi',
        'ruang',
        'meja',
      ]) {
        const val = out[strField];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          out[strField] = String(val).trim();
        }
      }
    }
    return out;
  });
}

function normVal(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

export async function detectDuplicatesAndUnreadable(
  docType: ImportDocType,
  rows: Array<Record<string, unknown>>,
  examId?: number | null,
  pageLogs: ImportPageLog[] = [],
  fileDuplicateWarning: string | null = null
): Promise<{
  unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }>;
  duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }>;
  row_issues: ImportRowIssue[];
  summary: ImportSummaryReport;
}> {
  const unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }> = [];
  const duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }> = [];
  const row_issues: ImportRowIssue[] = [];

  const requiredByType: Record<ImportDocType, string[]> = {
    data_peserta: ['nomor_peserta', 'nama', 'kelas'],
    data_pengawas: ['nama_lengkap'],
    jadwal_ujian: ['tanggal', 'jam_mulai', 'jam_selesai', 'mata_pelajaran', 'kode_ruang'],
    jadwal_pengawasan: ['tanggal', 'jam_mulai', 'jam_selesai', 'mata_pelajaran', 'kode_ruang', 'pengawas_utama'],
    pembagian_ruang: ['kode_ruang', 'nomor_peserta'],
    denah_peserta: ['kode_ruang', 'kode_kursi', 'baris', 'kolom'],
    daftar_hadir_peserta: ['nomor_peserta', 'nama'],
    denah_lingkungan: ['kode_ruang', 'nama_ruang'],
    dokumen_pendukung: [],
  };

  const requiredFields = requiredByType[docType] || [];
  const seenNomorPeserta = new Set<string>();
  const seenNisn = new Set<string>();
  const seenNip = new Set<string>();
  const seenScheduleSlot = new Set<string>();

  let estimatedNew = 0;
  let estimatedUpdated = 0;
  let estimatedUnchanged = 0;
  let failedCount = 0;
  let duplicatesCount = 0;

  // Determine target exam_id for checking student diffing (single bulk query to avoid N+1 timeouts on serverless)
  let effectiveExamId = examId || null;
  if (!effectiveExamId && docType === 'data_peserta' && isDatabaseConfigured()) {
    const latestExam = await queryOne<{ id: number }>(`SELECT id FROM exams ORDER BY id DESC LIMIT 1`);
    effectiveExamId = latestExam ? Number(latestExam.id) : null;
  }

  type ExistingStudentDiffRow = {
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
  };
  const existingStudentsMap = new Map<string, ExistingStudentDiffRow>();
  if (effectiveExamId && isDatabaseConfigured() && docType === 'data_peserta') {
    const existingList = await query<ExistingStudentDiffRow>(
      `SELECT no_urut, nisn, nis, nama, jk, kelas, user_ujian, password_ujian, sesi, ruang, meja, status, nomor_peserta
       FROM students WHERE exam_id = $1`,
      [effectiveExamId]
    );
    for (const st of existingList) {
      if (st.nomor_peserta) {
        existingStudentsMap.set(String(st.nomor_peserta).trim(), st);
      }
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    let rowFailed = false;
    let rowDuplicateInFile = false;

    for (const field of requiredFields) {
      const val = row[field];
      const fallbackNama = field === 'nama' ? row.nama_lengkap : undefined;
      const effectiveVal =
        val !== null && val !== undefined && String(val).trim() !== '' ? val : fallbackNama;
      if (effectiveVal === null || effectiveVal === undefined || String(effectiveVal).trim() === '') {
        const reason = `Kolom wajib "${field}" kosong atau tidak terbaca (BR-08)`;
        unreadable_fields.push({ rowIndex, field, reason });
        row_issues.push({ rowIndex, kind: 'failed', field, reason });
        rowFailed = true;
      }
    }

    if (row._lowConfidence === true) {
      const reason = 'Tingkat keyakinan OCR rendah, wajib diperiksa Admin';
      unreadable_fields.push({ rowIndex, field: '*', reason });
      row_issues.push({ rowIndex, kind: 'warning', field: '*', reason });
    }

    if (row.nomor_peserta) {
      const key = String(row.nomor_peserta).trim();
      if (seenNomorPeserta.has(key)) {
        const reason = 'Duplikat Nomor Peserta di dalam berkas impor';
        duplicates.push({ rowIndex, field: 'nomor_peserta', value: key, source: reason });
        row_issues.push({ rowIndex, kind: 'duplicate', field: 'nomor_peserta', value: key, reason });
        rowDuplicateInFile = true;
      } else {
        seenNomorPeserta.add(key);
        if (effectiveExamId && isDatabaseConfigured() && docType === 'data_peserta' && !rowFailed) {
          const existing = existingStudentsMap.get(key) ?? null;

          if (existing) {
            const incomingNama = normVal(row.nama ?? row.nama_lengkap);
            const incomingKelas = normVal(row.kelas) || 'Umum';
            const incomingRuang = normVal(row.ruang ?? row.kode_ruang);
            const incomingSesi = normVal(row.sesi ?? row.nama_sesi);
            const incomingStatus = normVal(row.status) || 'Aktif';

            const unchanged =
              normVal(existing.no_urut) === normVal(row.no_urut) &&
              normVal(existing.nisn) === normVal(row.nisn) &&
              normVal(existing.nis) === normVal(row.nis) &&
              normVal(existing.nama) === incomingNama &&
              normVal(existing.jk) === normVal(row.jk) &&
              normVal(existing.kelas) === incomingKelas &&
              normVal(existing.user_ujian) === normVal(row.user_ujian) &&
              normVal(existing.password_ujian) === normVal(row.password_ujian) &&
              normVal(existing.sesi) === incomingSesi &&
              normVal(existing.ruang) === incomingRuang &&
              normVal(existing.meja) === normVal(row.meja) &&
              (normVal(existing.status) || 'Aktif') === incomingStatus;

            if (unchanged) {
              estimatedUnchanged++;
              row_issues.push({
                rowIndex,
                kind: 'unchanged',
                field: 'nomor_peserta',
                value: key,
                reason: 'Data peserta sudah tersimpan di database dan tidak ada perubahan nilai',
              });
            } else {
              estimatedUpdated++;
              duplicates.push({
                rowIndex,
                field: 'nomor_peserta',
                value: key,
                source: 'Sudah terdaftar di database dengan perubahan data (akan diperbarui saat konfirmasi)',
              });
            }
          } else {
            estimatedNew++;
          }
        } else if (!rowFailed) {
          estimatedNew++;
        }
      }
    } else if (!rowFailed) {
      estimatedNew++;
    }

    if (row.nisn) {
      const nisn = String(row.nisn).trim();
      if (nisn && seenNisn.has(nisn)) {
        const reason = 'NISN ganda dalam berkas impor';
        duplicates.push({ rowIndex, field: 'nisn', value: nisn, source: reason });
        row_issues.push({ rowIndex, kind: 'duplicate', field: 'nisn', value: nisn, reason });
      } else if (nisn) {
        seenNisn.add(nisn);
      }
    }

    if (row.nip_nuptk) {
      const nip = String(row.nip_nuptk).trim();
      if (nip && seenNip.has(nip)) {
        duplicates.push({
          rowIndex,
          field: 'nip_nuptk',
          value: nip,
          source: 'NIP/NUPTK ganda dalam berkas',
        });
      } else if (nip) {
        seenNip.add(nip);
      }
    }

    if ((docType === 'jadwal_ujian' || docType === 'jadwal_pengawasan') && (row.kode_ruang || row.ruang) && row.tanggal && row.jam_mulai) {
      const ruangVal = row.kode_ruang ?? row.ruang;
      const sesiVal = normVal(row.nama_sesi ?? row.sesi) || 'Sesi 1';
      const slot = `${sesiVal}|${ruangVal}|${row.tanggal}|${row.jam_mulai}`;
      if (seenScheduleSlot.has(slot)) {
        duplicates.push({
          rowIndex,
          field: 'kode_ruang',
          value: `${sesiVal} · ${ruangVal} (${row.tanggal} ${row.jam_mulai})`,
          source: 'Jadwal sesi, ruang & waktu bertabrakan di berkas',
        });
      } else {
        seenScheduleSlot.add(slot);
      }
    }

    if (rowFailed) failedCount++;
    if (rowDuplicateInFile) duplicatesCount++;
  }

  for (const pl of pageLogs) {
    if (pl.status === 'failed' && pl.message) {
      unreadable_fields.push({
        rowIndex: -1,
        field: `Halaman ${pl.pageNumber}`,
        reason: pl.message,
      });
      row_issues.push({
        rowIndex: -1,
        kind: 'failed',
        field: `Halaman ${pl.pageNumber}`,
        reason: pl.message,
      });
    }
  }

  const failureReasons = row_issues
    .filter((i) => i.kind === 'failed' || i.kind === 'duplicate')
    .map((i) => ({
      rowIndex: i.rowIndex,
      field: i.field,
      value: i.value,
      reason: i.reason,
    }));

  const summary: ImportSummaryReport = {
    totalRows: rows.length,
    parsedCount: Math.max(0, rows.length - failedCount),
    inserted: estimatedNew,
    updated: estimatedUpdated,
    unchanged: estimatedUnchanged,
    duplicatesCount,
    failedCount,
    skippedCount: estimatedUnchanged + duplicatesCount + failedCount,
    failureReasons,
    pageLogs,
    fileDuplicateWarning,
    archiveOnlyNote:
      docType === 'dokumen_pendukung' && rows.length === 0
        ? 'Dokumen tersimpan sebagai arsip pendukung; tidak ada pemetaan tabel terstruktur.'
        : null,
  };

  return { unreadable_fields, duplicates, row_issues, summary };
}

function readCellText(sheet: XLSX.WorkSheet, row: number, col: number): string | null {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[addr];
  if (!cell) return null;
  if (cell.t === 's' || cell.t === 'str') {
    const val = String(cell.v ?? '').trim();
    return val === '' ? null : val;
  }
  if (cell.w !== undefined && cell.w !== null) {
    const val = String(cell.w).trim();
    return val === '' ? null : val;
  }
  if (cell.v !== undefined && cell.v !== null) {
    const val = String(cell.v).trim();
    return val === '' ? null : val;
  }
  return null;
}

function extractSheetRowsSmart(
  workbook: XLSX.WorkBook,
  targetType?: ImportDocType | null
): { headers: string[]; rows: Array<Record<string, unknown>>; sheetName: string } {
  let sheetName = workbook.SheetNames[0];
  const exactPesertaSheet = workbook.SheetNames.find(
    (n) => n.trim().toLowerCase() === 'data peserta'
  );
  if ((targetType === 'data_peserta' || !targetType) && exactPesertaSheet) {
    sheetName = exactPesertaSheet;
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) {
    return { headers: [], rows: [], sheetName };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const matrix: Array<Array<string | null>> = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const rowArr: Array<string | null> = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      rowArr.push(readCellText(sheet, r, c));
    }
    matrix.push(rowArr);
  }

  const knownMarkers = new Set([
    'no_urut',
    'nisn',
    'nis',
    'nama',
    'nama_lengkap',
    'jk',
    'kelas',
    'nomor_peserta',
    'user_ujian',
    'password_ujian',
    'sesi',
    'ruang',
    'kode_ruang',
    'meja',
    'status',
    'nip_nuptk',
    'whatsapp',
    'kode_verifikasi',
    'kode_kursi',
    'baris',
    'kolom',
    'mata_pelajaran',
    'tanggal',
    'jam_mulai',
    'jam_selesai',
    'pengawas_utama',
  ]);

  let headerRowIdx = 0;
  let bestScore = -1;
  const maxScan = Math.min(matrix.length, 15);
  for (let r = 0; r < maxScan; r++) {
    let score = 0;
    for (const cell of matrix[r]) {
      if (!cell) continue;
      const nk = normalizeHeaderKey(cell, targetType);
      if (knownMarkers.has(nk)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = r;
    }
  }

  const rawHeaders = matrix[headerRowIdx] || [];
  const colEntries: Array<{ colIdx: number; key: string }> = [];
  const usedKeys = new Set<string>();
  for (let c = 0; c < rawHeaders.length; c++) {
    const rawH = rawHeaders[c];
    if (!rawH) continue;
    let key = normalizeHeaderKey(rawH, targetType);
    if (usedKeys.has(key)) {
      key = `${key}_${c + 1}`;
    }
    usedKeys.add(key);
    colEntries.push({ colIdx: c, key });
  }

  const rows: Array<Record<string, unknown>> = [];
  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const line = matrix[r];
    const hasAnyValue = colEntries.some((ce) => {
      const val = line[ce.colIdx];
      return val !== null && val !== undefined && val !== '';
    });
    if (!hasAnyValue) continue;

    const obj: Record<string, unknown> = {};
    for (const ce of colEntries) {
      obj[ce.key] = line[ce.colIdx] ?? null;
    }

    // Ignore trailing total/summary rows in Excel exports
    const firstVal = String(obj.no_urut ?? obj.nama ?? obj.nama_lengkap ?? '').toLowerCase();
    if (
      (firstVal === 'jumlah' || firstVal === 'total') &&
      !obj.nomor_peserta &&
      !obj.nisn
    ) {
      continue;
    }

    rows.push(obj);
  }

  return {
    headers: colEntries.map((c) => c.key),
    rows,
    sheetName,
  };
}

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
}

interface ReconstructedLine {
  y: number;
  items: PositionedTextItem[];
  text: string;
}

function reconstructLinesFromPdfItems(rawItems: Array<{ str?: string; transform?: number[] }>): ReconstructedLine[] {
  const items: PositionedTextItem[] = [];
  for (const it of rawItems) {
    const str = (it.str ?? '').trim();
    if (!str) continue;
    const x = Array.isArray(it.transform) ? Number(it.transform[4] || 0) : 0;
    const y = Array.isArray(it.transform) ? Number(it.transform[5] || 0) : 0;
    items.push({ str, x, y });
  }

  // Sort top-to-bottom (higher Y first in PDF coordinates), then left-to-right
  items.sort((a, b) => (Math.abs(b.y - a.y) > 3.5 ? b.y - a.y : a.x - b.x));

  const lines: ReconstructedLine[] = [];
  for (const item of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= 3.5) {
      last.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item], text: '' });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map((i) => i.str).join('  ');
  }
  return lines;
}

function parseTabularPdfLines(
  lines: ReconstructedLine[],
  targetType: ImportDocType | null | undefined,
  carryHeaders: Array<{ key: string; x: number }> | null
): {
  rows: Array<Record<string, unknown>>;
  detectedHeaders: Array<{ key: string; x: number }> | null;
} {
  const knownMarkers = new Set([
    'no_urut',
    'nisn',
    'nis',
    'nama',
    'nama_lengkap',
    'jk',
    'kelas',
    'nomor_peserta',
    'user_ujian',
    'password_ujian',
    'sesi',
    'ruang',
    'kode_ruang',
    'meja',
    'status',
    'nip_nuptk',
    'whatsapp',
    'kode_verifikasi',
    'kode_kursi',
    'baris',
    'kolom',
    'mata_pelajaran',
    'tanggal',
    'jam_mulai',
    'jam_selesai',
    'pengawas_utama',
  ]);

  let headerIdx = -1;
  let headers: Array<{ key: string; x: number }> | null = carryHeaders;

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const l = lines[i];
    const candidateCols: Array<{ key: string; x: number }> = [];
    let matchedCount = 0;
    for (const item of l.items) {
      const parts = item.str.split(/\s{2,}|\t|\|/).map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        const nk = normalizeHeaderKey(p, targetType);
        if (knownMarkers.has(nk)) matchedCount++;
        candidateCols.push({ key: nk, x: item.x });
      }
    }
    if (matchedCount >= 2) {
      headerIdx = i;
      headers = candidateCols;
      break;
    }
  }

  if (!headers || headers.length < 2) {
    return { rows: [], detectedHeaders: headers };
  }

  const startLine = headerIdx >= 0 ? headerIdx + 1 : 0;
  const rows: Array<Record<string, unknown>> = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const lowerText = line.text.toLowerCase();
    if (
      lowerText.includes('halaman ') ||
      lowerText.startsWith('dicetak') ||
      lowerText.startsWith('kementerian agama')
    ) {
      continue;
    }

    // Check if this row is a repeated table header on a multi-page PDF
    let repeatedScore = 0;
    for (const it of line.items) {
      if (knownMarkers.has(normalizeHeaderKey(it.str, targetType))) repeatedScore++;
    }
    if (repeatedScore >= 3) continue;

    // Assign items to closest header X column
    const rowObj: Record<string, unknown> = {};
    for (const h of headers) {
      rowObj[h.key] = null;
    }

    if (line.items.length >= 2) {
      for (const item of line.items) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let c = 0; c < headers.length; c++) {
          const dist = Math.abs(item.x - headers[c].x);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = c;
          }
        }
        const key = headers[bestIdx].key;
        const prev = rowObj[key];
        rowObj[key] = prev ? `${String(prev)} ${item.str}`.trim() : item.str;
      }
    } else {
      const parts = line.text.split(/\s{2,}|\t|\|/).map((p) => p.trim());
      headers.forEach((h, idx) => {
        if (parts[idx]) rowObj[h.key] = parts[idx];
      });
    }

    const nonEmptyValues = Object.values(rowObj).filter((v) => v !== null && String(v).trim() !== '');
    if (nonEmptyValues.length >= 2) {
      rows.push(rowObj);
    }
  }

  return { rows, detectedHeaders: headers };
}

function parsePlainOcrLines(
  rawText: string,
  targetType?: ImportDocType | null
): Array<Record<string, unknown>> {
  const textLines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (textLines.length === 0) return [];

  const pseudoLines: ReconstructedLine[] = textLines.map((t, idx) => {
    const cells = t.split(/\s{2,}|\t|\|/).map((c) => c.trim()).filter(Boolean);
    return {
      y: 1000 - idx * 20,
      items: cells.map((c, ci) => ({ str: c, x: ci * 100, y: 1000 - idx * 20 })),
      text: t,
    };
  });

  const parsed = parseTabularPdfLines(pseudoLines, targetType, null);
  return parsed.rows;
}

async function runGeminiOcrExtraction(params: {
  buffer: Buffer;
  mimeType: string;
  title: string;
  targetType?: ImportDocType | null;
}): Promise<{
  detected_type: ImportDocType;
  confidence: number;
  rows: Array<Record<string, unknown>>;
}> {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY!,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const targetHint = params.targetType
    ? `Dokumen ini diunggah admin pada tahap "${params.targetType}".`
    : 'Klasifikasikan jenis dokumen SAUM secara akurat.';

  const systemInstruction = `Anda adalah mesin ekstraksi dokumen ekspor SAUM untuk sistem pengawasan ujian madrasah (SIPENGUJI).
ATURAN WAJIB (BR-08):
1. Jangan pernah mengarang, menebak, atau melengkapi data yang tidak terbaca, buram, terpotong, atau kosong.
2. Jika suatu sel/field kosong atau tidak terbaca dengan pasti, isi dengan null (jangan menebak).
3. Jika ada baris dengan teks buram atau ragu-ragu, beri field lowConfidence: true pada baris tersebut.
4. Pertahankan angka nol di depan pada NISN, NIS, nomor peserta, atau nomor meja sebagai STRING persis sesuai gambar/PDF.
5. ${targetHint}
6. Tipe dan kolom resmi:
   - data_peserta / DNPU (kolom: no_urut, nisn, nis, nama, jk, kelas, nomor_peserta, user_ujian, password_ujian, sesi, ruang, meja, status)
   - data_pengawas (kolom: nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi)
   - jadwal_ujian (kolom: nama_sesi, tanggal [YYYY-MM-DD], jam_mulai [HH:MM], jam_selesai [HH:MM], kode_mapel, mata_pelajaran, kode_ruang, nama_ruang)
   - jadwal_pengawasan (kolom: nama_sesi, tanggal [YYYY-MM-DD], jam_mulai [HH:MM], jam_selesai [HH:MM], kode_mapel, mata_pelajaran, kode_ruang, nama_ruang, pengawas_utama, pengawas_pendamping)
   - pembagian_ruang (kolom: kode_ruang, nama_ruang, kapasitas, nomor_peserta, nama)
   - denah_peserta (kolom: kode_ruang, nama_ruang, kode_kursi, baris, kolom, nomor_peserta, nama)
   - daftar_hadir_peserta (kolom: nomor_peserta, nama, kelas, kode_ruang)
   - denah_lingkungan (kolom: kode_ruang, nama_ruang, keterangan)
   - dokumen_pendukung (jika hanya dokumen naratif/surat pendukung tanpa tabel data, kembalikan rows: [])`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: params.mimeType,
            data: params.buffer.toString('base64'),
          },
        },
        {
          text: `Ekstrak seluruh baris tabel atau daftar dari halaman/dokumen berjudul "${params.title}". Kembalikan JSON terstruktur sesuai skema. Ingat aturan BR-08: field yang tidak jelas wajib bernilai null dan jangan mengarang data.`,
        },
      ],
    },
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detected_type: {
            type: Type.STRING,
            description: 'Jenis dokumen SAUM yang terdeteksi.',
          },
          confidence: {
            type: Type.NUMBER,
            description: 'Skor keyakinan klasifikasi 0.0 hingga 1.0.',
          },
          rows: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                no_urut: { type: Type.STRING, nullable: true },
                nomor_peserta: { type: Type.STRING, nullable: true },
                nisn: { type: Type.STRING, nullable: true },
                nis: { type: Type.STRING, nullable: true },
                nama: { type: Type.STRING, nullable: true },
                jk: { type: Type.STRING, nullable: true },
                kelas: { type: Type.STRING, nullable: true },
                user_ujian: { type: Type.STRING, nullable: true },
                password_ujian: { type: Type.STRING, nullable: true },
                sesi: { type: Type.STRING, nullable: true },
                ruang: { type: Type.STRING, nullable: true },
                meja: { type: Type.STRING, nullable: true },
                status: { type: Type.STRING, nullable: true },
                nama_lengkap: { type: Type.STRING, nullable: true },
                nip_nuptk: { type: Type.STRING, nullable: true },
                whatsapp: { type: Type.STRING, nullable: true },
                kode_verifikasi: { type: Type.STRING, nullable: true },
                kode_ruang: { type: Type.STRING, nullable: true },
                nama_ruang: { type: Type.STRING, nullable: true },
                kapasitas: { type: Type.STRING, nullable: true },
                kode_kursi: { type: Type.STRING, nullable: true },
                baris: { type: Type.STRING, nullable: true },
                kolom: { type: Type.STRING, nullable: true },
                nama_sesi: { type: Type.STRING, nullable: true },
                tanggal: { type: Type.STRING, nullable: true },
                jam_mulai: { type: Type.STRING, nullable: true },
                jam_selesai: { type: Type.STRING, nullable: true },
                kode_mapel: { type: Type.STRING, nullable: true },
                mata_pelajaran: { type: Type.STRING, nullable: true },
                pengawas_utama: { type: Type.STRING, nullable: true },
                pengawas_pendamping: { type: Type.STRING, nullable: true },
                lowConfidence: { type: Type.BOOLEAN, nullable: true },
              },
            },
          },
        },
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    detected_type?: string;
    confidence?: number;
    rows?: Array<Record<string, unknown>>;
  };

  const detectedType: ImportDocType = VALID_DOC_TYPES.includes(parsed.detected_type as ImportDocType)
    ? (parsed.detected_type as ImportDocType)
    : params.targetType || 'dokumen_pendukung';

  const cleanedRows = (parsed.rows ?? []).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'lowConfidence') {
        if (v === true) out._lowConfidence = true;
      } else if (v !== null && v !== undefined && String(v).trim() !== '') {
        out[k] = String(v).trim();
      } else {
        out[k] = null;
      }
    }
    return out;
  });

  return {
    detected_type: detectedType,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.78,
    rows: cleanedRows,
  };
}

async function runTesseractOcr(imageBuffer: Buffer): Promise<string> {
  const worker = await createWorker('eng', 1, {
    cachePath: '/tmp/tesseract-cache',
  });
  try {
    const result = await worker.recognize(imageBuffer);
    return result.data?.text || '';
  } finally {
    await worker.terminate();
  }
}

async function extractEmbeddedImagesFromPdfPage(
  srcDoc: PDFDocument,
  pageIndexZeroBased: number
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  const page = srcDoc.getPage(pageIndexZeroBased);
  const resources = page.node.Resources();
  if (!resources) return images;
  const xObject = resources.get(PDFName.of('XObject'));
  if (!xObject) return images;
  const xObjDict = srcDoc.context.lookup(xObject);
  if (!xObjDict || typeof (xObjDict as { entries?: unknown }).entries !== 'function') return images;

  for (const [, ref] of (xObjDict as unknown as { entries: () => Iterable<[PDFName, unknown]> }).entries()) {
    const obj = srcDoc.context.lookup(ref as never);
    if (obj instanceof PDFRawStream) {
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      const filter = obj.dict.get(PDFName.of('Filter'));
      if (
        subtype === PDFName.of('Image') &&
        (filter === PDFName.of('DCTDecode') || String(filter).includes('DCTDecode'))
      ) {
        images.push(Buffer.from(obj.contents));
      }
    }
  }
  return images;
}

export async function extractDocumentFromBuffer(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  examId?: number | null,
  targetType?: ImportDocType | null,
  fileDuplicateWarning: string | null = null
): Promise<ExtractionResult> {
  const ext = path.extname(originalName).toLowerCase();

  // 1. SPREADSHEET (XLSX / XLS / CSV)
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const workbook = XLSX.read(fileBuffer, {
      type: 'buffer',
      cellText: true,
      cellDates: true,
    });
    const { headers, rows } = extractSheetRowsSmart(workbook, targetType);
    const classified = classifyByHeaders(headers, targetType);
    const detectedType = targetType === 'dokumen_pendukung' ? 'dokumen_pendukung' : classified.type;
    const finalizedRows = finalizeRowsForType(rows, detectedType);

    if (finalizedRows.length === 0 && detectedType !== 'dokumen_pendukung') {
      throw new Error(
        `Berkas "${originalName}" terbaca kosong atau struktur header kolom tidak dikenali untuk jenis "${detectedType}".`
      );
    }

    const analysis = await detectDuplicatesAndUnreadable(
      detectedType,
      finalizedRows,
      examId,
      [],
      fileDuplicateWarning
    );

    return {
      detected_type: detectedType,
      confidence: classified.confidence,
      rows: finalizedRows,
      unreadable_fields: analysis.unreadable_fields,
      duplicates: analysis.duplicates,
      page_logs: [],
      row_issues: analysis.row_issues,
      summary: analysis.summary,
    };
  }

  // 2. PDF (TEXT LAYER CHECK PER PAGE -> DIRECT EXTRACTION OR PAGE-BY-PAGE OCR)
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    let pdfJsDoc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
    let pdfLibDoc: PDFDocument;
    try {
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(fileBuffer),
        useSystemFonts: true,
        disableFontFace: true,
        verbosity: 0,
      });
      pdfJsDoc = await loadingTask.promise;
      pdfLibDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Struktur PDF rusak atau terenkripsi.';
      throw new Error(`Gagal membuka berkas PDF "${originalName}": ${reason}`);
    }

    const totalPages = pdfJsDoc.numPages;
    if (totalPages === 0) {
      throw new Error(`Berkas PDF "${originalName}" tidak memiliki halaman.`);
    }

    const pageLogs: ImportPageLog[] = [];
    const collectedRows: Array<Record<string, unknown>> = [];
    let resolvedType: ImportDocType = targetType || 'dokumen_pendukung';
    let bestConfidence = targetType ? 0.8 : 0.6;
    let carryHeaders: Array<{ key: string; x: number }> | null = null;
    const rawPageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      try {
        const page = await pdfJsDoc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const lines = reconstructLinesFromPdfItems(
          textContent.items as Array<{ str?: string; transform?: number[] }>
        );
        const pageText = lines.map((l) => l.text).join('\n');
        const nonSpaceChars = pageText.replace(/\s+/g, '').length;

        if (nonSpaceChars >= 25) {
          // PDF page HAS a text layer -> extract directly without paid API
          rawPageTexts.push(pageText);
          if (targetType === 'dokumen_pendukung') {
            pageLogs.push({
              pageNumber,
              method: 'archive_only',
              status: 'unmapped',
              rowCount: 0,
              message: 'Halaman berteks diarsipkan sebagai dokumen pendukung (tanpa pemetaan tabel).',
            });
            continue;
          }

          const parsedPage = parseTabularPdfLines(lines, targetType, carryHeaders);
          if (parsedPage.detectedHeaders) {
            carryHeaders = parsedPage.detectedHeaders;
            if (!targetType) {
              const cls = classifyByHeaders(
                parsedPage.detectedHeaders.map((h) => h.key),
                null
              );
              if (cls.type !== 'dokumen_pendukung') {
                resolvedType = cls.type;
                bestConfidence = Math.max(bestConfidence, cls.confidence);
              }
            }
          }

          if (parsedPage.rows.length > 0) {
            collectedRows.push(...parsedPage.rows);
            pageLogs.push({
              pageNumber,
              method: 'text_layer',
              status: 'success',
              rowCount: parsedPage.rows.length,
              message: `Lapisan teks terbaca (${parsedPage.rows.length} baris).`,
            });
          } else if (process.env.GEMINI_API_KEY) {
            // Text layer exists but layout is irregular -> use single-page Gemini parser
            const subDoc = await PDFDocument.create();
            const [copiedPage] = await subDoc.copyPages(pdfLibDoc, [pageNumber - 1]);
            subDoc.addPage(copiedPage);
            const singlePageBytes = Buffer.from(await subDoc.save());

            const aiRes = await runGeminiOcrExtraction({
              buffer: singlePageBytes,
              mimeType: 'application/pdf',
              title: `${originalName} (Halaman ${pageNumber}/${totalPages})`,
              targetType,
            });
            if (!targetType && aiRes.detected_type !== 'dokumen_pendukung') {
              resolvedType = aiRes.detected_type;
              bestConfidence = Math.max(bestConfidence, aiRes.confidence);
            }
            collectedRows.push(...aiRes.rows);
            pageLogs.push({
              pageNumber,
              method: 'ocr_gemini',
              status: aiRes.rows.length > 0 ? 'success' : 'failed',
              rowCount: aiRes.rows.length,
              message:
                aiRes.rows.length > 0
                  ? `Teks halaman ${pageNumber} dipetakan ke ${aiRes.rows.length} baris.`
                  : `Halaman ${pageNumber} memiliki teks tetapi tidak membentuk tabel yang dapat dipetakan.`,
            });
          } else {
            pageLogs.push({
              pageNumber,
              method: 'text_layer',
              status: 'failed',
              rowCount: 0,
              message: `Halaman ${pageNumber} memiliki lapisan teks (${nonSpaceChars} karakter) tetapi tidak ditemukan header tabel yang sesuai.`,
            });
          }
        } else {
          // Scanned PDF page (no text layer) -> OCR page-by-page in strict order
          if (targetType === 'dokumen_pendukung' && !process.env.GEMINI_API_KEY) {
            pageLogs.push({
              pageNumber,
              method: 'archive_only',
              status: 'unmapped',
              rowCount: 0,
              message: 'Halaman scan diarsipkan sebagai dokumen pendukung (ekstraksi tabel belum tersedia).',
            });
            continue;
          }

          if (process.env.GEMINI_API_KEY) {
            const subDoc = await PDFDocument.create();
            const [copiedPage] = await subDoc.copyPages(pdfLibDoc, [pageNumber - 1]);
            subDoc.addPage(copiedPage);
            const singlePageBytes = Buffer.from(await subDoc.save());

            const aiRes = await runGeminiOcrExtraction({
              buffer: singlePageBytes,
              mimeType: 'application/pdf',
              title: `${originalName} (Halaman ${pageNumber}/${totalPages})`,
              targetType,
            });

            if (targetType === 'dokumen_pendukung') {
              pageLogs.push({
                pageNumber,
                method: 'archive_only',
                status: 'unmapped',
                rowCount: 0,
                message: 'Halaman scan disimpan sebagai arsip dokumen pendukung.',
              });
            } else {
              if (!targetType && aiRes.detected_type !== 'dokumen_pendukung') {
                resolvedType = aiRes.detected_type;
                bestConfidence = Math.max(bestConfidence, aiRes.confidence);
              }
              collectedRows.push(...aiRes.rows);
              pageLogs.push({
                pageNumber,
                method: 'ocr_gemini',
                status: aiRes.rows.length > 0 ? 'success' : 'failed',
                rowCount: aiRes.rows.length,
                message:
                  aiRes.rows.length > 0
                    ? `OCR halaman scan ${pageNumber} mengekstrak ${aiRes.rows.length} baris.`
                    : `OCR tidak menemukan baris tabel terbaca pada halaman ${pageNumber}.`,
              });
            }
          } else {
            // Fallback local OCR via embedded raster images (JPEG) + Tesseract
            const embeddedJpegs = await extractEmbeddedImagesFromPdfPage(pdfLibDoc, pageNumber - 1);
            if (embeddedJpegs.length === 0) {
              pageLogs.push({
                pageNumber,
                method: 'ocr_tesseract',
                status: 'failed',
                rowCount: 0,
                message: `Halaman ${pageNumber} adalah hasil scan tanpa lapisan teks dan tanpa stream gambar JPEG langsung; OCR membutuhkan GEMINI_API_KEY.`,
              });
              continue;
            }

            let pageOcrText = '';
            for (const imgBuf of embeddedJpegs) {
              pageOcrText += '\n' + (await runTesseractOcr(imgBuf));
            }
            const parsedOcrRows = parsePlainOcrLines(pageOcrText, targetType);
            collectedRows.push(...parsedOcrRows);
            pageLogs.push({
              pageNumber,
              method: 'ocr_tesseract',
              status: parsedOcrRows.length > 0 ? 'success' : 'failed',
              rowCount: parsedOcrRows.length,
              message:
                parsedOcrRows.length > 0
                  ? `OCR lokal halaman ${pageNumber} mengekstrak ${parsedOcrRows.length} baris.`
                  : `OCR lokal tidak berhasil mengenali struktur tabel pada halaman ${pageNumber}.`,
            });
          }
        }
      } catch (pageErr) {
        const reason = pageErr instanceof Error ? pageErr.message : 'Kesalahan tidak terduga saat membaca halaman.';
        pageLogs.push({
          pageNumber,
          method: 'skipped',
          status: 'failed',
          rowCount: 0,
          message: `Halaman ${pageNumber} gagal diproses: ${reason}`,
        });
      }
    }

    if (resolvedType === 'dokumen_pendukung') {
      const analysis = await detectDuplicatesAndUnreadable(
        'dokumen_pendukung',
        [],
        examId,
        pageLogs,
        fileDuplicateWarning
      );
      return {
        detected_type: 'dokumen_pendukung',
        confidence: 0.9,
        rows: [],
        unreadable_fields: analysis.unreadable_fields,
        duplicates: analysis.duplicates,
        page_logs: pageLogs,
        row_issues: analysis.row_issues,
        summary: {
          ...analysis.summary,
          archiveOnlyNote:
            'Berkas PDF tersimpan sebagai arsip dokumen pendukung; ekstraksi tabel terstruktur belum tersedia untuk dokumen pendukung.',
        },
      };
    }

    const failedPages = pageLogs.filter((p) => p.status === 'failed');
    if (collectedRows.length === 0) {
      const reasonsText =
        failedPages.map((p) => p.message).filter(Boolean).join(' | ') ||
        'Tidak ada baris data yang berhasil diekstrak dari seluruh halaman PDF.';
      const err = new Error(
        `Ekstraksi PDF gagal (${totalPages} halaman diperiksa, ${failedPages.length} halaman gagal): ${reasonsText}`
      ) as Error & { pageLogs?: ImportPageLog[] };
      err.pageLogs = pageLogs;
      throw err;
    }

    const finalizedRows = finalizeRowsForType(collectedRows, resolvedType);
    const analysis = await detectDuplicatesAndUnreadable(
      resolvedType,
      finalizedRows,
      examId,
      pageLogs,
      fileDuplicateWarning
    );

    return {
      detected_type: resolvedType,
      confidence: bestConfidence,
      rows: finalizedRows,
      unreadable_fields: analysis.unreadable_fields,
      duplicates: analysis.duplicates,
      page_logs: pageLogs,
      row_issues: analysis.row_issues,
      summary: analysis.summary,
    };
  }

  // 3. IMAGES (PNG / JPG / JPEG / WEBP)
  const resolvedMime =
    mimeType && mimeType !== 'application/octet-stream'
      ? mimeType
      : ext === '.png'
      ? 'image/png'
      : ext === '.webp'
      ? 'image/webp'
      : 'image/jpeg';

  if (targetType === 'dokumen_pendukung' && !process.env.GEMINI_API_KEY) {
    const pageLogs: ImportPageLog[] = [
      {
        pageNumber: 1,
        method: 'archive_only',
        status: 'unmapped',
        rowCount: 0,
        message: 'Gambar tersimpan sebagai arsip dokumen pendukung (ekstraksi tabel belum tersedia).',
      },
    ];
    const analysis = await detectDuplicatesAndUnreadable(
      'dokumen_pendukung',
      [],
      examId,
      pageLogs,
      fileDuplicateWarning
    );
    return {
      detected_type: 'dokumen_pendukung',
      confidence: 0.9,
      rows: [],
      unreadable_fields: analysis.unreadable_fields,
      duplicates: analysis.duplicates,
      page_logs: pageLogs,
      row_issues: analysis.row_issues,
      summary: {
        ...analysis.summary,
        archiveOnlyNote:
          'Gambar diarsipkan sebagai dokumen pendukung; ekstraksi tabel terstruktur tidak dilakukan.',
      },
    };
  }

  if (process.env.GEMINI_API_KEY) {
    const aiRes = await runGeminiOcrExtraction({
      buffer: fileBuffer,
      mimeType: resolvedMime,
      title: originalName,
      targetType,
    });
    const detectedType = targetType === 'dokumen_pendukung' ? 'dokumen_pendukung' : aiRes.detected_type;
    const finalizedRows =
      detectedType === 'dokumen_pendukung' ? [] : finalizeRowsForType(aiRes.rows, detectedType);

    if (detectedType !== 'dokumen_pendukung' && finalizedRows.length === 0) {
      throw new Error(
        `OCR gambar "${originalName}" tidak menemukan baris data yang dapat dipetakan ke jenis "${detectedType}".`
      );
    }

    const pageLogs: ImportPageLog[] = [
      {
        pageNumber: 1,
        method: detectedType === 'dokumen_pendukung' ? 'archive_only' : 'ocr_gemini',
        status: detectedType === 'dokumen_pendukung' ? 'unmapped' : 'success',
        rowCount: finalizedRows.length,
        message:
          detectedType === 'dokumen_pendukung'
            ? 'Gambar tersimpan sebagai arsip dokumen pendukung.'
            : `OCR gambar mengekstrak ${finalizedRows.length} baris.`,
      },
    ];

    const analysis = await detectDuplicatesAndUnreadable(
      detectedType,
      finalizedRows,
      examId,
      pageLogs,
      fileDuplicateWarning
    );

    return {
      detected_type: detectedType,
      confidence: aiRes.confidence,
      rows: finalizedRows,
      unreadable_fields: analysis.unreadable_fields,
      duplicates: analysis.duplicates,
      page_logs: pageLogs,
      row_issues: analysis.row_issues,
      summary: analysis.summary,
    };
  }

  // Fallback local OCR via Tesseract for PNG/JPG when GEMINI_API_KEY is unset
  let ocrText = '';
  try {
    ocrText = await runTesseractOcr(fileBuffer);
  } catch (ocrErr) {
    const reason = ocrErr instanceof Error ? ocrErr.message : 'OCR Tesseract gagal dijalankan.';
    throw new Error(
      `Gagal menjalankan OCR pada gambar "${originalName}": ${reason}. Pastikan gambar jelas atau konfigurasi GEMINI_API_KEY.`
    );
  }

  const parsedRows = parsePlainOcrLines(ocrText, targetType);
  if (parsedRows.length === 0) {
    throw new Error(
      `OCR lokal pada gambar "${originalName}" tidak menghasilkan baris tabel yang terbaca untuk "${targetType || 'dokumen'}". Periksa kualitas/ketajaman scan atau konfigurasi GEMINI_API_KEY.`
    );
  }

  const resolvedType = targetType || classifyByHeaders(Object.keys(parsedRows[0]), null).type;
  const finalizedRows = finalizeRowsForType(parsedRows, resolvedType);
  const pageLogs: ImportPageLog[] = [
    {
      pageNumber: 1,
      method: 'ocr_tesseract',
      status: 'success',
      rowCount: finalizedRows.length,
      message: `OCR lokal mengekstrak ${finalizedRows.length} baris dari gambar.`,
    },
  ];
  const analysis = await detectDuplicatesAndUnreadable(
    resolvedType,
    finalizedRows,
    examId,
    pageLogs,
    fileDuplicateWarning
  );

  return {
    detected_type: resolvedType,
    confidence: 0.72,
    rows: finalizedRows,
    unreadable_fields: analysis.unreadable_fields,
    duplicates: analysis.duplicates,
    page_logs: pageLogs,
    row_issues: analysis.row_issues,
    summary: analysis.summary,
  };
}

export function buildTemplateWorkbook(templateType: string): Buffer {
  const today = getServerWibNow().date;
  let headers: string[] = [];
  let sampleRows: Array<Record<string, string | number>> = [];
  let sheetName = 'Ekspor_SAUM';

  if (templateType === 'data_pengawas') {
    headers = ['nama_lengkap', 'nip_nuptk', 'whatsapp', 'kode_verifikasi'];
    sampleRows = [
      { nama_lengkap: 'Siti Aminah, S.Pd.', nip_nuptk: '198604122010012014', whatsapp: '081234567801', kode_verifikasi: 'PGW-01' },
      { nama_lengkap: 'Andi Pratama, M.Pd.', nip_nuptk: '198907182014031003', whatsapp: '081234567802', kode_verifikasi: 'PGW-02' },
    ];
  } else if (templateType === 'data_peserta') {
    sheetName = 'Data Peserta';
    headers = [
      'No',
      'NISN',
      'NIS',
      'Nama Lengkap',
      'JK',
      'Kelas',
      'Nomor Peserta',
      'User Ujian',
      'Password Ujian',
      'Sesi',
      'Ruang',
      'Meja',
      'Status',
    ];
    sampleRows = [
      {
        No: '1',
        NISN: '0084112201',
        NIS: '24001',
        'Nama Lengkap': 'Ahmad Fauzan',
        JK: 'L',
        Kelas: 'XII IPA 1',
        'Nomor Peserta': 'UM-26-0001',
        'User Ujian': 'peserta0001',
        'Password Ujian': 'UM26*0001',
        Sesi: 'Sesi 1',
        Ruang: 'R-01',
        Meja: 'A1',
        Status: 'Aktif',
      },
    ];
  } else if (templateType === 'denah_peserta') {
    headers = ['kode_ruang', 'nama_ruang', 'kode_kursi', 'baris', 'kolom', 'nomor_peserta', 'nama'];
    sampleRows = [
      { kode_ruang: 'R-01', nama_ruang: 'Ruang 01 — Al-Khawarizmi', kode_kursi: 'A1', baris: 1, kolom: 1, nomor_peserta: 'UM-26-0001', nama: 'Ahmad Fauzan' },
    ];
  } else {
    headers = ['nama_sesi', 'tanggal', 'jam_mulai', 'jam_selesai', 'kode_mapel', 'mata_pelajaran', 'kode_ruang', 'nama_ruang', 'pengawas_utama', 'pengawas_pendamping'];
    sampleRows = [
      {
        nama_sesi: 'Sesi 1',
        tanggal: today,
        jam_mulai: '07:30',
        jam_selesai: '09:30',
        kode_mapel: 'PAI-FIQ',
        mata_pelajaran: 'Fikih',
        kode_ruang: 'R-01',
        nama_ruang: 'Ruang 01 — Al-Khawarizmi',
        pengawas_utama: 'Siti Aminah, S.Pd.',
        pengawas_pendamping: 'Andi Pratama, M.Pd.',
      },
    ];
  }

  const ws = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
