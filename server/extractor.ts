import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import * as XLSX from 'xlsx';
import type { ImportDocType } from '../src/types.ts';
import { queryOne } from './db.ts';
import { getServerWibNow } from './time.ts';

export interface ExtractionResult {
  detected_type: ImportDocType;
  confidence: number;
  rows: Array<Record<string, unknown>>;
  unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }>;
  duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }>;
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

function normalizeHeaderKey(raw: string): string {
  const k = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const aliasMap: Record<string, string> = {
    no_peserta: 'nomor_peserta',
    nomor_ujian: 'nomor_peserta',
    id_peserta: 'nomor_peserta',
    nama_peserta: 'nama',
    nama_siswa: 'nama',
    rombel: 'kelas',
    tingkat_kelas: 'kelas',
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
    ruang: 'kode_ruang',
    ruangan: 'kode_ruang',
    kode_ruangan: 'kode_ruang',
    nama_ruangan: 'nama_ruang',
    kursi: 'kode_kursi',
    no_kursi: 'kode_kursi',
    nomor_kursi: 'kode_kursi',
    row: 'baris',
    col: 'kolom',
    mapel: 'mata_pelajaran',
    nama_mapel: 'mata_pelajaran',
    kode_mapel: 'kode_mapel',
    sesi_ujian: 'nama_sesi',
    sesi: 'nama_sesi',
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

function classifyByHeaders(headers: string[]): { type: ImportDocType; confidence: number } {
  const set = new Set(headers);
  if (set.has('kode_kursi') || (set.has('baris') && set.has('kolom'))) {
    return { type: 'denah_peserta', confidence: 0.94 };
  }
  if (set.has('nomor_peserta') && (set.has('nama') || set.has('nisn'))) {
    if (set.has('kode_ruang') && !set.has('kelas')) {
      return { type: 'pembagian_ruang', confidence: 0.88 };
    }
    return { type: 'data_peserta', confidence: 0.95 };
  }
  if ((set.has('nama_lengkap') || set.has('nip_nuptk')) && !set.has('mata_pelajaran')) {
    return { type: 'data_pengawas', confidence: 0.92 };
  }
  if (set.has('mata_pelajaran') && (set.has('pengawas_utama') || set.has('pengawas_pendamping'))) {
    return { type: 'jadwal_pengawasan', confidence: 0.94 };
  }
  if (set.has('mata_pelajaran') && set.has('tanggal') && set.has('jam_mulai')) {
    return { type: 'jadwal_ujian', confidence: 0.9 };
  }
  if (set.has('kode_ruang') && set.has('kapasitas')) {
    return { type: 'pembagian_ruang', confidence: 0.85 };
  }
  return { type: 'dokumen_pendukung', confidence: 0.52 };
}

export async function detectDuplicatesAndUnreadable(
  docType: ImportDocType,
  rows: Array<Record<string, unknown>>,
  examId?: number | null
): Promise<{
  unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }>;
  duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }>;
}> {
  const unreadable_fields: Array<{ rowIndex: number; field: string; reason: string }> = [];
  const duplicates: Array<{ rowIndex: number; field: string; value: string; source: string }> = [];

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

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    for (const field of requiredFields) {
      const val = row[field];
      if (val === null || val === undefined || String(val).trim() === '') {
        unreadable_fields.push({
          rowIndex,
          field,
          reason: 'Field wajib kosong atau tidak terbaca (BR-08: tidak diisi otomatis)',
        });
      }
    }
    if (row._lowConfidence === true) {
      unreadable_fields.push({
        rowIndex,
        field: '*',
        reason: 'Tingkat keyakinan OCR rendah, wajib diperiksa Admin',
      });
    }

    if (row.nomor_peserta) {
      const key = String(row.nomor_peserta).trim();
      if (seenNomorPeserta.has(key)) {
        duplicates.push({
          rowIndex,
          field: 'nomor_peserta',
          value: key,
          source: 'Duplikat di dalam berkas impor',
        });
      } else {
        seenNomorPeserta.add(key);
        if (examId && docType === 'data_peserta') {
          const existing = await queryOne<{ id: number }>(
            `SELECT id FROM students WHERE exam_id = $1 AND nomor_peserta = $2`,
            [examId, key]
          );
          if (existing) {
            duplicates.push({
              rowIndex,
              field: 'nomor_peserta',
              value: key,
              source: 'Sudah terdaftar pada kegiatan ujian ini (akan diperbarui jika dikonfirmasi)',
            });
          }
        }
      }
    }

    if (row.nisn) {
      const nisn = String(row.nisn).trim();
      if (nisn && seenNisn.has(nisn)) {
        duplicates.push({
          rowIndex,
          field: 'nisn',
          value: nisn,
          source: 'NISN ganda dalam berkas',
        });
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

    if ((docType === 'jadwal_ujian' || docType === 'jadwal_pengawasan') && row.kode_ruang && row.tanggal && row.jam_mulai) {
      const slot = `${row.kode_ruang}|${row.tanggal}|${row.jam_mulai}`;
      if (seenScheduleSlot.has(slot)) {
        duplicates.push({
          rowIndex,
          field: 'kode_ruang',
          value: `${row.kode_ruang} (${row.tanggal} ${row.jam_mulai})`,
          source: 'Jadwal ruang & waktu bertabrakan di berkas',
        });
      } else {
        seenScheduleSlot.add(slot);
      }
    }
  }

  return { unreadable_fields, duplicates };
}

export async function extractDocumentFromBuffer(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  examId?: number | null
): Promise<ExtractionResult> {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false,
    });

    const normalizedRows = rawRows.map((raw) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        const nk = normalizeHeaderKey(k);
        clean[nk] = v === '' ? null : typeof v === 'string' ? v.trim() : v;
      }
      return clean;
    });

    const headers = normalizedRows.length > 0 ? Object.keys(normalizedRows[0]) : [];
    const { type, confidence } = classifyByHeaders(headers);
    const { unreadable_fields, duplicates } = await detectDuplicatesAndUnreadable(
      type,
      normalizedRows,
      examId
    );

    return {
      detected_type: type,
      confidence,
      rows: normalizedRows,
      unreadable_fields,
      duplicates,
    };
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY belum dikonfigurasi di Environment Variables untuk ekstraksi PDF/gambar hasil scan. Gunakan file XLSX/CSV atau atur GEMINI_API_KEY di Vercel.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const base64Data = fileBuffer.toString('base64');
  const resolvedMime =
    mimeType && mimeType !== 'application/octet-stream'
      ? mimeType
      : ext === '.pdf'
      ? 'application/pdf'
      : ext === '.png'
      ? 'image/png'
      : 'image/jpeg';

  const systemInstruction = `Anda adalah mesin ekstraksi dokumen ekspor SAUM untuk sistem pengawasan ujian madrasah (SIPENGUJI).
ATURAN WAJIB (BR-08):
1. Jangan pernah mengarang, menebak, atau melengkapi data yang tidak terbaca, buram, terpotong, atau kosong.
2. Jika suatu sel/field kosong atau tidak terbaca dengan pasti, isi dengan null (jangan menebak).
3. Jika ada baris dengan teks buram atau ragu-ragu, beri field lowConfidence: true pada baris tersebut.
4. Klasifikasikan dokumen ke salah satu tipe berikut:
   - data_peserta (kolom: nomor_peserta, nisn, nis, nama, kelas, kode_ruang)
   - data_pengawas (kolom: nama_lengkap, nip_nuptk, whatsapp, kode_verifikasi)
   - jadwal_ujian (kolom: nama_sesi, tanggal [YYYY-MM-DD], jam_mulai [HH:MM], jam_selesai [HH:MM], kode_mapel, mata_pelajaran, kode_ruang, nama_ruang)
   - jadwal_pengawasan (kolom: nama_sesi, tanggal [YYYY-MM-DD], jam_mulai [HH:MM], jam_selesai [HH:MM], kode_mapel, mata_pelajaran, kode_ruang, nama_ruang, pengawas_utama, pengawas_pendamping)
   - pembagian_ruang (kolom: kode_ruang, nama_ruang, kapasitas, nomor_peserta, nama)
   - denah_peserta (kolom: kode_ruang, nama_ruang, kode_kursi, baris, kolom, nomor_peserta, nama)
   - daftar_hadir_peserta (kolom: nomor_peserta, nama, kelas, kode_ruang)
   - denah_lingkungan (kolom: kode_ruang, nama_ruang, keterangan)
   - dokumen_pendukung`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: resolvedMime,
            data: base64Data,
          },
        },
        {
          text: `Ekstrak seluruh baris tabel atau daftar dari dokumen ekspor SAUM berjudul "${originalName}". Kembalikan JSON terstruktur sesuai skema. Ingat aturan BR-08: field yang tidak jelas wajib bernilai null.`,
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
                nomor_peserta: { type: Type.STRING, nullable: true },
                nisn: { type: Type.STRING, nullable: true },
                nis: { type: Type.STRING, nullable: true },
                nama: { type: Type.STRING, nullable: true },
                kelas: { type: Type.STRING, nullable: true },
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
    : 'dokumen_pendukung';

  const cleanedRows = (parsed.rows ?? []).map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'lowConfidence') {
        if (v === true) out._lowConfidence = true;
      } else if (v !== null && v !== undefined && String(v).trim() !== '') {
        out[k] = v;
      } else {
        out[k] = null;
      }
    }
    return out;
  });

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
  const { unreadable_fields, duplicates } = await detectDuplicatesAndUnreadable(
    detectedType,
    cleanedRows,
    examId
  );

  return {
    detected_type: detectedType,
    confidence,
    rows: cleanedRows,
    unreadable_fields,
    duplicates,
  };
}

export function buildTemplateWorkbook(templateType: string): Buffer {
  const today = getServerWibNow().date;
  let headers: string[] = [];
  let sampleRows: Array<Record<string, string | number>> = [];

  if (templateType === 'data_pengawas') {
    headers = ['nama_lengkap', 'nip_nuptk', 'whatsapp', 'kode_verifikasi'];
    sampleRows = [
      { nama_lengkap: 'Siti Aminah, S.Pd.', nip_nuptk: '198604122010012014', whatsapp: '081234567801', kode_verifikasi: 'PGW-01' },
      { nama_lengkap: 'Andi Pratama, M.Pd.', nip_nuptk: '198907182014031003', whatsapp: '081234567802', kode_verifikasi: 'PGW-02' },
      { nama_lengkap: 'Nur Hidayah, S.Ag.', nip_nuptk: '199103252019032009', whatsapp: '081234567803', kode_verifikasi: 'PGW-03' },
    ];
  } else if (templateType === 'data_peserta') {
    headers = ['nomor_peserta', 'nisn', 'nis', 'nama', 'kelas', 'kode_ruang'];
    sampleRows = [
      { nomor_peserta: 'UM-26-0001', nisn: '0084112201', nis: '24001', nama: 'Ahmad Fauzan', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
      { nomor_peserta: 'UM-26-0002', nisn: '0084112202', nis: '24002', nama: 'Aisyah Zahra', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
      { nomor_peserta: 'UM-26-0003', nisn: '0084112203', nis: '24003', nama: 'Muhammad Ridwan', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
      { nomor_peserta: 'UM-26-0004', nisn: '0084112204', nis: '24004', nama: 'Nadia Safitri', kelas: 'XII IPA 1', kode_ruang: 'R-01' },
    ];
  } else if (templateType === 'denah_peserta') {
    headers = ['kode_ruang', 'nama_ruang', 'kode_kursi', 'baris', 'kolom', 'nomor_peserta', 'nama'];
    sampleRows = [
      { kode_ruang: 'R-01', nama_ruang: 'Ruang 01 — Al-Khawarizmi', kode_kursi: 'A1', baris: 1, kolom: 1, nomor_peserta: 'UM-26-0001', nama: 'Ahmad Fauzan' },
      { kode_ruang: 'R-01', nama_ruang: 'Ruang 01 — Al-Khawarizmi', kode_kursi: 'A2', baris: 1, kolom: 2, nomor_peserta: 'UM-26-0002', nama: 'Aisyah Zahra' },
      { kode_ruang: 'R-01', nama_ruang: 'Ruang 01 — Al-Khawarizmi', kode_kursi: 'B1', baris: 2, kolom: 1, nomor_peserta: 'UM-26-0003', nama: 'Muhammad Ridwan' },
      { kode_ruang: 'R-01', nama_ruang: 'Ruang 01 — Al-Khawarizmi', kode_kursi: 'B2', baris: 2, kolom: 2, nomor_peserta: 'UM-26-0004', nama: 'Nadia Safitri' },
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
  XLSX.utils.book_append_sheet(wb, ws, 'Ekspor_SAUM');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
