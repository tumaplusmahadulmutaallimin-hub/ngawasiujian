import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CreditCard,
  Eye,
  EyeOff,
  FileCheck2,
  HelpCircle,
  KeyRound,
  Lock,
  MapPin,
  Phone,
  ShieldCheck,
  User,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { ApiError, apiFetch, setAuthToken } from '../lib/api.ts';
import type { AuthUser } from '../types.ts';
import { BrandMark, useServerWibClock } from './BrandMark.tsx';
import { SignaturePad } from './SignaturePad.tsx';

interface SupervisorDirectoryItem {
  id: number;
  nama_lengkap: string;
  nip_masked: string | null;
  requires_verification: boolean;
  already_registered: boolean;
}

interface AuthPortalProps {
  onAuthenticated: (user: AuthUser, token: string) => void;
}

export const AuthPortal: React.FC<AuthPortalProps> = ({ onAuthenticated }) => {
  const wibClock = useServerWibClock();
  const [authMode, setAuthMode] = useState<'supervisor_login' | 'supervisor_register' | 'admin_login'>(
    'supervisor_login'
  );
  const [needsAdminSetup, setNeedsAdminSetup] = useState(false);
  const [showForgotModal, setShowForgotModal] = useState(false);

  // Login states
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // First-run Admin bootstrap state
  const [adminBootUser, setAdminBootUser] = useState('admin');
  const [adminBootPass, setAdminBootPass] = useState('');
  const [adminBootConfirm, setAdminBootConfirm] = useState('');

  // Supervisor registration states (FR-AUT-02..06)
  const [directory, setDirectory] = useState<SupervisorDirectoryItem[]>([]);
  const [selectedSupId, setSelectedSupId] = useState<number | ''>('');
  const [verificationInput, setVerificationInput] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regNomorId, setRegNomorId] = useState('');
  const [regTempatLahir, setRegTempatLahir] = useState('');
  const [regTglLahir, setRegTglLahir] = useState('');
  const [regAlamat, setRegAlamat] = useState('');
  const [regWhatsapp, setRegWhatsapp] = useState('');
  const [regFoto, setRegFoto] = useState<string | null>(null);
  const [regTtd, setRegTtd] = useState<string | null>(null);

  // Forgot password states
  const [forgotUsername, setForgotUsername] = useState('');
  const [forgotCatatan, setForgotCatatan] = useState('');

  const loadStatusAndDir = async () => {
    try {
      const status = await apiFetch<{ needsAdminSetup?: boolean }>('/api/auth/status');
      const needsSetup = Boolean(status?.needsAdminSetup);
      setNeedsAdminSetup(needsSetup);
      if (needsSetup) {
        setAuthMode('admin_login');
      }
      const dir = await apiFetch<SupervisorDirectoryItem[]>('/api/auth/supervisors-directory');
      setDirectory(Array.isArray(dir) ? dir : []);
    } catch (err) {
      setDirectory([]);
      if (err instanceof ApiError && (err.status === 503 || err.status >= 500)) {
        setErrorMsg(err.message);
      }
    }
  };

  useEffect(() => {
    loadStatusAndDir();
  }, []);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setErrorMsg('Ukuran foto profil maksimal 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setRegFoto(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAdminBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (adminBootPass !== adminBootConfirm) {
      setErrorMsg('Konfirmasi password Admin tidak cocok.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/bootstrap-admin', {
        method: 'POST',
        body: JSON.stringify({ username: adminBootUser, password: adminBootPass }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user, res.token);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membuat akun Admin.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setLoading(true);
    try {
      const expectedRole = authMode === 'admin_login' ? 'admin' : 'supervisor';
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, expectedRole }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user, res.token);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal masuk.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSupervisor = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!selectedSupId) {
      setErrorMsg('Pilih nama Anda dari daftar pengawas resmi panitia.');
      return;
    }
    if (!regTtd) {
      setErrorMsg('Tanda tangan digital wajib dibuat sebelum mendaftar.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/register-supervisor', {
        method: 'POST',
        body: JSON.stringify({
          supervisorId: Number(selectedSupId),
          verificationInput,
          username: regUsername,
          password: regPassword,
          nomor_identitas: regNomorId,
          tempat_lahir: regTempatLahir,
          tgl_lahir: regTglLahir,
          alamat: regAlamat,
          whatsapp: regWhatsapp,
          foto_url: regFoto,
          ttd_url: regTtd,
        }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user, res.token);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Registrasi gagal.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ username: forgotUsername, catatan: forgotCatatan }),
      });
      setShowForgotModal(false);
      setInfoMsg(res.message);
      setForgotUsername('');
      setForgotCatatan('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal mengirim permintaan.');
    }
  };

  const safeDirectory = Array.isArray(directory) ? directory : [];
  const selectedSupObj = safeDirectory.find((d) => d.id === Number(selectedSupId));

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#172B4D] flex flex-col">
      {/* Top Institutional Bar */}
      <header className="bg-white border-b border-[#E5EAF0] px-4 sm:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-6">
          <BrandMark />
          <div className="hidden md:flex items-center gap-4 text-xs text-[#718096]">
            <span>Waktu Server Resmi</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular font-semibold text-[#10243A]">
              {wibClock.date} {wibClock.time} WIB
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setAuthMode('supervisor_login');
              setErrorMsg(null);
            }}
            className="px-4 py-2 rounded-lg border border-[#E5EAF0] bg-white hover:bg-[#E8F5EF] hover:border-[#087F5B]/30 text-xs font-semibold text-[#10243A] transition-colors whitespace-nowrap min-h-[40px]"
          >
            Portal Pengawas
          </button>
        </div>
      </header>

      {/* Main Split Canvas */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Area: Deep Navy Identity, Tagline & Architectural Exam Visual */}
        <section className="lg:col-span-5 bg-[#10243A] text-white rounded-2xl p-7 sm:p-9 flex flex-col justify-between gap-8 shadow-card relative overflow-hidden">
          <div className="space-y-5 relative z-10">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#C9A45C] tracking-wide">
              <ShieldCheck className="w-4 h-4" />
              <span>Sistem Informasi Pengawasan Ujian Madrasah</span>
            </div>

            <div className="space-y-2.5">
              <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                SIPENGUJI
              </h1>
              <p className="text-base sm:text-lg font-medium text-[#E8F5EF] leading-snug [text-wrap:balance]">
                “Pengawasan Terstruktur, Transparan, dan Terintegrasi.”
              </p>
              <p className="text-sm text-slate-300 leading-relaxed">
                Platform administrasi pengawasan ujian madrasah yang menghubungkan dokumen ekspor SAUM, denah peserta interaktif, serta pelaporan berita acara secara sinkron dan teraudit.
              </p>
            </div>

            {/* Custom Architectural Exam Room Vector Illustration */}
            <div className="rounded-xl bg-[#0B1929] border border-white/10 p-4">
              <svg
                viewBox="0 0 360 156"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="w-full h-auto"
                aria-label="Ilustrasi digital denah pengawasan ruang ujian SIPENGUJI"
              >
                {/* Desk / Podium header */}
                <rect x="96" y="10" width="168" height="20" rx="5" fill="#17324F" stroke="#C9A45C" strokeOpacity="0.55" />
                <text x="180" y="23" textAnchor="middle" fill="#C9A45C" fontSize="8" fontFamily="Plus Jakarta Sans, sans-serif" fontWeight="700">
                  MEJA PENGAWAS · WIB SINKRON
                </text>

                {/* Row 1 seats */}
                <rect x="20" y="44" width="72" height="42" rx="7" fill="#132C47" stroke="#087F5B" strokeWidth="1.5" />
                <text x="30" y="60" fill="#E8F5EF" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="700">A1 · HADIR</text>
                <rect x="30" y="68" width="46" height="5" rx="2.5" fill="#087F5B" />

                <rect x="102" y="44" width="72" height="42" rx="7" fill="#132C47" stroke="#334E68" />
                <text x="112" y="60" fill="#CBD5E1" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="600">A2 · HADIR</text>
                <rect x="112" y="68" width="40" height="5" rx="2.5" fill="#475569" />

                <rect x="186" y="44" width="72" height="42" rx="7" fill="#132C47" stroke="#C9A45C" strokeWidth="1.5" />
                <text x="196" y="60" fill="#FDE68A" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="700">A3 · P2</text>
                <rect x="196" y="68" width="44" height="5" rx="2.5" fill="#C9A45C" />

                <rect x="268" y="44" width="72" height="42" rx="7" fill="#132C47" stroke="#334E68" />
                <text x="278" y="60" fill="#CBD5E1" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="600">A4 · HADIR</text>
                <rect x="278" y="68" width="46" height="5" rx="2.5" fill="#475569" />

                {/* Row 2 seats */}
                <rect x="20" y="98" width="72" height="42" rx="7" fill="#132C47" stroke="#334E68" />
                <text x="30" y="114" fill="#CBD5E1" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="600">B1 · HADIR</text>
                <rect x="30" y="122" width="42" height="5" rx="2.5" fill="#475569" />

                <rect x="102" y="98" width="72" height="42" rx="7" fill="#1E293B" stroke="#94A3B8" strokeDasharray="3 2" />
                <text x="112" y="114" fill="#CBD5E1" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="600">B2 · IZIN</text>
                <rect x="112" y="122" width="34" height="5" rx="2.5" fill="#94A3B8" />

                <rect x="186" y="98" width="72" height="42" rx="7" fill="#132C47" stroke="#087F5B" strokeWidth="1.5" />
                <text x="196" y="114" fill="#E8F5EF" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="700">B3 · HADIR</text>
                <rect x="196" y="122" width="48" height="5" rx="2.5" fill="#087F5B" />

                <rect x="268" y="98" width="72" height="42" rx="7" fill="#3B1822" stroke="#E11D48" strokeWidth="1.5" />
                <text x="278" y="114" fill="#FDA4AF" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="700">B4 · P3</text>
                <rect x="278" y="122" width="46" height="5" rx="2.5" fill="#E11D48" />
              </svg>
            </div>
          </div>

          {/* Concise Capability Strip */}
          <div className="border-t border-white/15 pt-5 grid grid-cols-1 gap-3 text-xs text-slate-300 relative z-10">
            <div className="flex items-center gap-2.5">
              <FileCheck2 className="w-4 h-4 text-[#C9A45C] shrink-0" />
              <span>Impor XLSX, CSV, PDF & scan SAUM menjadi 11 dokumen administrasi otomatis</span>
            </div>
            <div className="flex items-center gap-2.5">
              <UserCheck className="w-4 h-4 text-[#C9A45C] shrink-0" />
              <span>Denah kursi interaktif dengan sinkronisasi real-time antar-pengawas</span>
            </div>
          </div>
        </section>

        {/* Right Area: Authentication Panel */}
        <section className="lg:col-span-7 flex flex-col justify-center">
          <div className="bg-white border border-[#E5EAF0] rounded-2xl p-6 sm:p-8 shadow-card">
            {/* Segmented Mode Switcher */}
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#F5F7FA] border border-[#E5EAF0] rounded-xl mb-6">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('supervisor_login');
                  setErrorMsg(null);
                }}
                className={`py-2.5 px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap min-h-[44px] ${
                  authMode === 'supervisor_login'
                    ? 'bg-white text-[#10243A] shadow-card'
                    : 'text-[#718096] hover:text-[#172B4D]'
                }`}
              >
                Masuk Pengawas
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('supervisor_register');
                  setErrorMsg(null);
                  loadStatusAndDir();
                }}
                className={`py-2.5 px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap min-h-[44px] ${
                  authMode === 'supervisor_register'
                    ? 'bg-white text-[#10243A] shadow-card'
                    : 'text-[#718096] hover:text-[#172B4D]'
                }`}
              >
                Buat Akun Pengawas
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('admin_login');
                  setErrorMsg(null);
                }}
                className={`py-2.5 px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap min-h-[44px] ${
                  authMode === 'admin_login'
                    ? 'bg-white text-[#10243A] shadow-card'
                    : 'text-[#718096] hover:text-[#172B4D]'
                }`}
              >
                Masuk Admin
              </button>
            </div>

            {errorMsg && (
              <div className="mb-5 p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-sm text-rose-800">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{errorMsg}</span>
              </div>
            )}

            {infoMsg && (
              <div className="mb-5 p-3.5 rounded-xl bg-[#E8F5EF] border border-[#087F5B]/30 flex items-start gap-2.5 text-sm text-[#087F5B]">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#087F5B]" />
                <span>{infoMsg}</span>
              </div>
            )}

            {/* FIRST-RUN ADMIN SETUP */}
            {authMode === 'admin_login' && needsAdminSetup ? (
              <form onSubmit={handleAdminBootstrap} className="space-y-4">
                <div className="pb-3 border-b border-[#E5EAF0]">
                  <h2 className="font-display text-xl font-bold text-[#10243A]">
                    Aktivasi Akun Admin Pertama
                  </h2>
                  <p className="text-sm text-[#718096] mt-1">
                    Buat akun Panitia (Admin) utama untuk memulai impor data SAUM dan pengelolaan jadwal ujian.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Username Admin</label>
                  <div className="relative">
                    <User className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      minLength={3}
                      value={adminBootUser}
                      onChange={(e) => setAdminBootUser(e.target.value)}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                      placeholder="admin"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                      Password (min. 8 karakter)
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={adminBootPass}
                        onChange={(e) => setAdminBootPass(e.target.value)}
                        className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                        placeholder="••••••••"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Konfirmasi Password</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={adminBootConfirm}
                        onChange={(e) => setAdminBootConfirm(e.target.value)}
                        className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                        placeholder="••••••••"
                      />
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white font-semibold text-sm transition-colors min-h-[48px] disabled:opacity-60"
                >
                  {loading ? 'Menyimpan Akun Admin...' : 'Buat Akun Admin & Masuk'}
                </button>
              </form>
            ) : authMode === 'supervisor_register' ? (
              /* PENGAWAS REGISTRATION (FR-AUT-02..06) */
              <form onSubmit={handleRegisterSupervisor} className="space-y-4">
                <div className="pb-3 border-b border-[#E5EAF0]">
                  <h2 className="font-display text-xl font-bold text-[#10243A]">
                    Registrasi Akun Pengawas
                  </h2>
                  <p className="text-sm text-[#718096] mt-1">
                    Pilih nama Anda dari daftar pengawas resmi Panitia (BR-02) lalu lengkapi profil dan tanda tangan digital.
                  </p>
                </div>

                {safeDirectory.length === 0 ? (
                  <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
                    Daftar pengawas belum tersedia. Admin perlu mengunggah dan mengonfirmasi data pengawas dari ekspor SAUM terlebih dahulu.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                          Pilih Nama Pengawas *
                        </label>
                        <div className="relative">
                          <UserCheck className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <select
                            required
                            value={selectedSupId}
                            onChange={(e) => setSelectedSupId(e.target.value ? Number(e.target.value) : '')}
                            className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                          >
                            <option value="">-- Pilih nama resmi --</option>
                            {safeDirectory.map((d) => (
                              <option key={d.id} value={d.id} disabled={d.already_registered}>
                                {d.nama_lengkap} {d.already_registered ? '(Sudah Terdaftar)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                          Kode Verifikasi / 4 Digit NIP {selectedSupObj?.requires_verification ? '*' : ''}
                        </label>
                        <div className="relative">
                          <KeyRound className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            required={Boolean(selectedSupObj?.requires_verification)}
                            value={verificationInput}
                            onChange={(e) => setVerificationInput(e.target.value)}
                            placeholder={
                              selectedSupObj?.nip_masked
                                ? `Contoh: PGW-01 atau ${selectedSupObj.nip_masked}`
                                : 'Kode dari Admin'
                            }
                            className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Username *</label>
                        <div className="relative">
                          <User className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            required
                            minLength={3}
                            value={regUsername}
                            onChange={(e) => setRegUsername(e.target.value)}
                            placeholder="mis. siti.aminah"
                            className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                          Password (min. 8 karakter) *
                        </label>
                        <div className="relative">
                          <Lock className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="password"
                            required
                            minLength={8}
                            value={regPassword}
                            onChange={(e) => setRegPassword(e.target.value)}
                            placeholder="••••••••"
                            className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[46px]"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">No. WhatsApp</label>
                        <div className="relative">
                          <Phone className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="tel"
                            value={regWhatsapp}
                            onChange={(e) => setRegWhatsapp(e.target.value)}
                            placeholder="0812..."
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[44px]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Tempat Lahir</label>
                        <div className="relative">
                          <MapPin className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={regTempatLahir}
                            onChange={(e) => setRegTempatLahir(e.target.value)}
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[44px]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Tanggal Lahir</label>
                        <div className="relative">
                          <Calendar className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <input
                            type="date"
                            value={regTglLahir}
                            onChange={(e) => setRegTglLahir(e.target.value)}
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[44px]"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                          NIK / Nomor Identitas
                        </label>
                        <div className="relative">
                          <CreditCard className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={regNomorId}
                            onChange={(e) => setRegNomorId(e.target.value)}
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[44px]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Alamat Domisili</label>
                        <div className="relative">
                          <MapPin className="w-4 h-4 text-[#718096] absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={regAlamat}
                            onChange={(e) => setRegAlamat(e.target.value)}
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[44px]"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">
                        Foto Profil (opsional, maks. 2 MB)
                      </label>
                      <div className="flex items-center gap-4">
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={handlePhotoUpload}
                          className="block w-full text-sm text-[#718096] file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border file:border-[#E5EAF0] file:text-xs file:font-semibold file:bg-[#F5F7FA] file:text-[#172B4D] hover:file:bg-slate-100"
                        />
                        {regFoto && (
                          <img
                            src={regFoto}
                            alt="Pratinjau foto profil"
                            className="w-11 h-11 rounded-full object-cover border border-[#E5EAF0] shrink-0"
                          />
                        )}
                      </div>
                    </div>

                    <SignaturePad
                      value={regTtd}
                      onChange={setRegTtd}
                      label="Tanda Tangan Digital (Wajib untuk Berita Acara) *"
                    />

                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-3 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors min-h-[48px] disabled:opacity-60"
                    >
                      <UserPlus className="w-4 h-4" />
                      {loading ? 'Mendaftarkan Akun...' : 'Buat Akun & Hubungkan Identitas'}
                    </button>
                  </>
                )}
              </form>
            ) : (
              /* LOGIN ADMIN OR LOGIN PENGAWAS */
              <form onSubmit={handleLogin} className="space-y-5">
                <div className="pb-3 border-b border-[#E5EAF0]">
                  <h2 className="font-display text-xl font-bold text-[#10243A]">
                    {authMode === 'admin_login' ? 'Masuk Admin / Panitia Ujian' : 'Masuk Pengawas Ruang'}
                  </h2>
                  <p className="text-sm text-[#718096] mt-1">
                    {authMode === 'admin_login'
                      ? 'Kelola impor dokumen SAUM, generator administrasi, verifikasi laporan, dan monitoring terpusat.'
                      : 'Masuk untuk memeriksa jadwal pengawasan aktif dan membuka denah ruang tugas Anda.'}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#172B4D] mb-1.5">Username</label>
                  <div className="relative">
                    <User className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={authMode === 'admin_login' ? 'admin' : 'username pengawas'}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[48px]"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-semibold text-[#172B4D]">Password</label>
                    {authMode === 'supervisor_login' && (
                      <button
                        type="button"
                        onClick={() => setShowForgotModal(true)}
                        className="text-xs font-semibold text-[#087F5B] hover:text-[#06694B] inline-flex items-center gap-1"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        Lupa password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-[#718096] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type={showPass ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Masukkan password akun"
                      className="w-full pl-10 pr-11 py-2.5 rounded-xl border border-[#E5EAF0] text-sm focus:outline-none focus:ring-2 focus:ring-[#087F5B] min-h-[48px]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      aria-label="Tampilkan atau sembunyikan password"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-[#718096] hover:text-[#172B4D]"
                    >
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl bg-[#087F5B] hover:bg-[#06694B] text-white font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors min-h-[48px] disabled:opacity-60"
                >
                  <Lock className="w-4 h-4" />
                  {loading
                    ? 'Memverifikasi Kredensial...'
                    : authMode === 'admin_login'
                    ? 'Masuk ke Konsol Admin'
                    : 'Masuk ke Dashboard Pengawas'}
                </button>
              </form>
            )}
          </div>
        </section>
      </main>

      {/* Forgot Password Modal (FR-AUT-08) */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 bg-[#10243A]/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#E5EAF0] rounded-2xl max-w-md w-full p-6 space-y-4 shadow-elevated">
            <h3 className="font-display text-lg font-bold text-[#10243A]">Ajukan Reset Password</h3>
            <p className="text-sm text-[#718096]">
              Permintaan reset password diteruskan ke Panitia (Admin) agar Admin dapat menerbitkan password baru untuk akun Anda.
            </p>
            <form onSubmit={handleForgotSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-[#172B4D] mb-1">Username Akun</label>
                <input
                  type="text"
                  required
                  value={forgotUsername}
                  onChange={(e) => setForgotUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                  placeholder="Masukkan username"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#172B4D] mb-1">Catatan / Ruang Tugas</label>
                <input
                  type="text"
                  value={forgotCatatan}
                  onChange={(e) => setForgotCatatan(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E5EAF0] text-sm min-h-[44px]"
                  placeholder="Misal: Ruang 01 Sesi 1"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForgotModal(false)}
                  className="px-4 py-2 rounded-xl border border-[#E5EAF0] text-sm font-medium text-[#172B4D] hover:bg-[#F5F7FA] min-h-[42px]"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-[#087F5B] text-white text-sm font-semibold hover:bg-[#06694B] min-h-[42px]"
                >
                  Kirim ke Admin
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
