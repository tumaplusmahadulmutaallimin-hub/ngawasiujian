import React, { useState } from 'react';
import { Download, Printer, X } from 'lucide-react';
import { generateAdminDocumentPdf, type DocDataset } from '../lib/pdfGenerator.ts';

interface DocumentViewerModalProps {
  docKey: string;
  title: string;
  version: number;
  dataset: DocDataset;
  defaultRoomKode?: string;
  onClose: () => void;
}

export const DocumentViewerModal: React.FC<DocumentViewerModalProps> = ({
  docKey,
  title,
  version,
  dataset,
  defaultRoomKode,
  onClose,
}) => {
  const [selectedRoomKode, setSelectedRoomKode] = useState<string>(
    defaultRoomKode || dataset.rooms[0]?.kode || ''
  );

  const activeRoom = dataset.rooms.find((r) => r.kode === selectedRoomKode) || dataset.rooms[0];
  const madrasah = dataset.exam?.madrasah_nama || 'Madrasah Aliyah Negeri';
  const examName = dataset.exam?.nama || 'Ujian Madrasah';
  const tahun = dataset.exam?.tahun_ajaran || '2026/2027';

  return (
    <div className="fixed inset-0 z-50 bg-[#10243A]/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white border border-[#E5EAF0] rounded-2xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden shadow-elevated">
        <div className="no-print flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-[#E5EAF0] bg-[#F5F7FA]">
          <div className="min-w-0">
            <h3 className="font-display text-base font-bold text-[#10243A] truncate">{title}</h3>
            <p className="text-xs text-[#718096] font-mono-tabular mt-0.5">
              Versi {version} · {dataset.serverTime.date} {dataset.serverTime.time} WIB
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dataset.rooms.length > 0 &&
              ['cover', 'denah_peserta', 'daftar_hadir_peserta', 'berita_acara'].includes(docKey) && (
                <select
                  value={selectedRoomKode}
                  onChange={(e) => setSelectedRoomKode(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs font-medium text-[#172B4D] min-h-[40px]"
                >
                  {dataset.rooms.map((r) => (
                    <option key={r.id} value={r.kode}>
                      {r.kode} — {r.nama}
                    </option>
                  ))}
                </select>
              )}
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E5EAF0] bg-white text-xs font-semibold text-[#172B4D] hover:bg-slate-50 min-h-[40px]"
            >
              <Printer className="w-3.5 h-3.5" />
              Cetak
            </button>
            <button
              type="button"
              onClick={() => generateAdminDocumentPdf(docKey, title, dataset, version, selectedRoomKode)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#087F5B] text-white text-xs font-semibold hover:bg-[#06694B] min-h-[40px]"
            >
              <Download className="w-3.5 h-3.5" />
              Unduh PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup pratinjau"
              className="p-2 rounded-xl text-[#718096] hover:bg-slate-200/70 min-h-[40px] min-w-[40px] flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-8 bg-[#F5F7FA]">
          <div className="print-page max-w-[780px] mx-auto bg-white border border-[#E5EAF0] rounded-xl p-8 sm:p-10 space-y-6 text-[#172B4D] shadow-card">
            <div className="text-center border-b-2 border-[#10243A] pb-4 space-y-1">
              <p className="text-xs font-semibold tracking-wider uppercase text-[#718096]">
                Kementerian Agama Republik Indonesia
              </p>
              <h1 className="font-display text-lg font-bold uppercase text-[#10243A]">{madrasah}</h1>
              <p className="text-sm text-[#172B4D]">
                {examName} · Tahun Ajaran {tahun}
              </p>
            </div>

            <div className="text-center">
              <h2 className="font-display text-base font-bold uppercase tracking-wide text-[#10243A]">
                {title.replace(/^\d+\.\s*/, '')}
              </h2>
              <p className="text-xs text-[#718096] mt-0.5 font-mono-tabular">
                Versi {version} · Sumber Data Terkonfirmasi SIPENGUJI
              </p>
            </div>

            {docKey === 'cover' && (
              <div className="border-2 border-[#087F5B] rounded-lg p-8 text-center space-y-6 my-4">
                <p className="text-sm font-semibold text-[#087F5B] uppercase tracking-wider">
                  Berkas Administrasi Ruang Ujian
                </p>
                <div className="space-y-2">
                  <p className="text-2xl font-display font-bold text-[#10243A]">{examName}</p>
                  <p className="text-base text-[#172B4D]">Tahun Pelajaran {tahun}</p>
                </div>
                <div className="py-4 border-y border-[#E5EAF0]">
                  <p className="text-lg font-bold text-[#10243A]">
                    {activeRoom ? `${activeRoom.kode} — ${activeRoom.nama}` : 'Seluruh Ruang Ujian'}
                  </p>
                  <p className="text-sm text-[#718096] mt-1">
                    Periode: {dataset.exam?.tanggal_mulai || '-'} s.d. {dataset.exam?.tanggal_selesai || '-'}
                  </p>
                </div>
                <p className="text-xs text-[#718096]">Panitia Penyelenggara Ujian · {madrasah}</p>
              </div>
            )}

            {docKey === 'denah_lingkungan' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {dataset.rooms.map((r) => (
                  <div key={r.id} className="border border-slate-300 p-4 rounded-lg bg-[#F5F7FA]">
                    <p className="font-mono-tabular font-bold text-sm text-[#10243A]">{r.kode}</p>
                    <p className="text-sm font-medium mt-1">{r.nama}</p>
                    <p className="text-xs text-[#718096] mt-2">
                      Kapasitas: {r.kapasitas} kursi ({r.rows_count}×{r.cols_count})
                    </p>
                  </div>
                ))}
              </div>
            )}

            {docKey === 'denah_peserta' && activeRoom && (
              <div className="space-y-4">
                <p className="text-sm font-semibold text-[#10243A]">
                  Ruang: {activeRoom.kode} — {activeRoom.nama}
                </p>
                <div className="border border-slate-300 bg-[#F5F7FA] text-center py-2 text-xs font-semibold rounded">
                  MEJA PENGAWAS / PAPAN TULIS
                </div>
                <div
                  className="grid gap-2.5"
                  style={{
                    gridTemplateColumns: `repeat(${Math.max(1, activeRoom.cols_count)}, minmax(0, 1fr))`,
                  }}
                >
                  {activeRoom.seats.map((s) => (
                    <div key={s.kode_kursi} className="border border-slate-300 p-2 rounded text-xs">
                      <p className="font-mono-tabular font-bold text-[#10243A]">{s.kode_kursi}</p>
                      <p className="font-medium truncate mt-0.5">{s.student_nama || 'Kosong'}</p>
                      <p className="text-[11px] text-[#718096] font-mono-tabular">{s.nomor_peserta || '-'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {docKey === 'jadwal_ujian' && (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F5F7FA]">
                    <th className="border border-slate-300 p-2 text-left">Tanggal</th>
                    <th className="border border-slate-300 p-2 text-left">Waktu WIB</th>
                    <th className="border border-slate-300 p-2 text-left">Ruang</th>
                    <th className="border border-slate-300 p-2 text-left">Mata Pelajaran</th>
                    <th className="border border-slate-300 p-2 text-left">Pengawas</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.schedules.map((s) => (
                    <tr key={s.id}>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{s.tanggal}</td>
                      <td className="border border-slate-300 p-2 font-mono-tabular">
                        {s.jam_mulai}-{s.jam_selesai}
                      </td>
                      <td className="border border-slate-300 p-2">{s.room_kode}</td>
                      <td className="border border-slate-300 p-2">{s.subject_nama}</td>
                      <td className="border border-slate-300 p-2">
                        {s.co_supervisors.map((c) => `${c.nama_lengkap} (${c.peran})`).join(', ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {(docKey === 'tata_tertib_peserta' || docKey === 'tata_tertib_pengawas') && (
              <ol className="list-decimal pl-5 space-y-2.5 text-sm leading-relaxed">
                {(docKey === 'tata_tertib_peserta'
                  ? [
                      'Peserta wajib hadir di ruang ujian paling lambat 15 menit sebelum ujian dimulai.',
                      'Peserta duduk sesuai nomor kursi yang tertera pada denah ruang ujian.',
                      'Peserta dilarang membawa alat komunikasi, catatan, atau perangkat elektronik ke kursi ujian.',
                      'Peserta wajib menandatangani daftar hadir yang diedarkan oleh pengawas ruang.',
                      'Peserta yang keluar ruangan sementara wajib memperoleh izin dari pengawas.',
                      'Setiap pelanggaran tata tertib dicatat sebagai Peringatan Tingkat 1, 2, atau 3 untuk ditindaklanjuti panitia.',
                    ]
                  : [
                      'Pengawas hadir di ruang ujian paling lambat 20 menit sebelum ujian dimulai.',
                      'Pengawas melakukan pemeriksaan kesesuaian identitas peserta dan denah kursi.',
                      'Pengawas mencatat kehadiran peserta dan kehadirannya sendiri melalui SIPENGUJI.',
                      'Pengawas mencatat peringatan beserta alasan objektif apabila terjadi pelanggaran.',
                      'Pengawas mencatat waktu keluar dan kembali peserta yang meminta izin keluar.',
                      'Pada akhir sesi, pengawas menyusun Berita Acara dan mengunggah Daftar Hadir bertanda tangan.',
                    ]
                ).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            )}

            {docKey === 'daftar_hadir_peserta' && (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F5F7FA]">
                    <th className="border border-slate-300 p-2 text-left">No</th>
                    <th className="border border-slate-300 p-2 text-left">Kursi</th>
                    <th className="border border-slate-300 p-2 text-left">No. Peserta</th>
                    <th className="border border-slate-300 p-2 text-left">Nama Peserta</th>
                    <th className="border border-slate-300 p-2 text-left">Kelas</th>
                    <th className="border border-slate-300 p-2 text-left">Tanda Tangan</th>
                  </tr>
                </thead>
                <tbody>
                  {(activeRoom?.seats.filter((s) => s.student_nama) || []).map((st, idx) => (
                    <tr key={st.kode_kursi}>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{idx + 1}</td>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{st.kode_kursi}</td>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{st.nomor_peserta}</td>
                      <td className="border border-slate-300 p-2">{st.student_nama}</td>
                      <td className="border border-slate-300 p-2">{st.kelas}</td>
                      <td className="border border-slate-300 p-2 h-8"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {docKey === 'daftar_hadir_pengawas' && (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F5F7FA]">
                    <th className="border border-slate-300 p-2 text-left">No</th>
                    <th className="border border-slate-300 p-2 text-left">Nama Pengawas</th>
                    <th className="border border-slate-300 p-2 text-left">NIP / NUPTK</th>
                    <th className="border border-slate-300 p-2 text-left">No. WhatsApp</th>
                    <th className="border border-slate-300 p-2 text-left">Paraf</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.supervisors.map((sup, idx) => (
                    <tr key={sup.id}>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{idx + 1}</td>
                      <td className="border border-slate-300 p-2">{sup.nama_lengkap}</td>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{sup.nip_nuptk || '-'}</td>
                      <td className="border border-slate-300 p-2 font-mono-tabular">{sup.whatsapp || '-'}</td>
                      <td className="border border-slate-300 p-2 h-8"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {docKey === 'berita_acara' && (
              <div className="space-y-4 text-sm">
                <p>
                  Pada hari ini tanggal{' '}
                  <span className="font-mono-tabular font-medium">
                    {dataset.schedules[0]?.tanggal || dataset.serverTime.date}
                  </span>
                  , telah dilaksanakan pengawasan {examName} pada ruang{' '}
                  <span className="font-semibold">
                    {activeRoom ? `${activeRoom.kode} (${activeRoom.nama})` : '-'}
                  </span>
                  .
                </p>
                <div className="border border-slate-300 rounded p-4 space-y-2 text-xs">
                  <p>
                    Jumlah Peserta Terdaftar: {activeRoom?.seats.filter((s) => s.student_nama).length || 0} orang
                  </p>
                  <p>Jumlah Hadir / Tidak Hadir: Terhitung otomatis pada formulir digital saat sesi selesai.</p>
                  <p>Catatan Kondisi Ruang: ___________________________________________________________</p>
                </div>
                <div className="grid grid-cols-2 gap-8 pt-10 text-center text-xs">
                  <div>
                    <p>Pengawas Utama</p>
                    <div className="h-16" />
                    <p>( ________________________ )</p>
                  </div>
                  <div>
                    <p>Pengawas Pendamping</p>
                    <div className="h-16" />
                    <p>( ________________________ )</p>
                  </div>
                </div>
              </div>
            )}

            {docKey === 'catatan_kejadian' && (
              <div className="space-y-3 text-xs">
                {dataset.incidents.length === 0 && dataset.warnings.length === 0 ? (
                  <p className="text-[#718096]">Tidak ada kejadian khusus atau peringatan tercatat saat ini.</p>
                ) : (
                  <ul className="space-y-2">
                    {dataset.incidents.map((inc) => (
                      <li key={inc.id} className="border border-slate-300 p-2.5 rounded">
                        <span className="font-mono-tabular font-semibold">{inc.waktu}</span> · {inc.dicatat_oleh_nama}:{' '}
                        {inc.deskripsi}
                      </li>
                    ))}
                    {dataset.warnings.map((w) => (
                      <li key={w.id} className="border border-slate-300 p-2.5 rounded">
                        <span className="font-semibold">Peringatan {w.tingkat}</span> ·{' '}
                        <span className="font-mono-tabular">{w.waktu_server}</span> · {w.student_nama} (
                        {w.nomor_peserta}): {w.alasan}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {docKey === 'serah_terima' && (
              <div className="space-y-4 text-sm">
                <p>
                  Dokumen ini menyatakan telah dilakukan serah terima berkas ujian dari Pengawas Ruang kepada Panitia Ujian Madrasah:
                </p>
                <ul className="space-y-2 text-xs">
                  <li>[ ] Amplop Soal & Naskah Ujian</li>
                  <li>[ ] Lembar Jawaban Peserta</li>
                  <li>[ ] Daftar Hadir Peserta & Pengawas Bertanda Tangan</li>
                  <li>[ ] Berita Acara & Catatan Kejadian Khusus</li>
                </ul>
                <div className="grid grid-cols-2 gap-8 pt-10 text-center text-xs">
                  <div>
                    <p>Yang Menyerahkan (Pengawas)</p>
                    <div className="h-16" />
                    <p>( ________________________ )</p>
                  </div>
                  <div>
                    <p>Yang Menerima (Panitia)</p>
                    <div className="h-16" />
                    <p>( ________________________ )</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
