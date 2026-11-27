import crypto from 'crypto';
import path from 'path';
import { get as blobGet, put as blobPut } from '@vercel/blob';

export interface StoredFileResult {
  storagePath: string;
  blobUrl: string | null;
  fileBytes: Buffer | null;
  mimeType: string;
  sha256: string;
  safeFilename: string;
  storageProvider: 'vercel-blob' | 'postgres-bytea';
}

const PREVIEW_BLOB_NOTICE =
  'Token Vercel Blob (BLOB_READ_WRITE_TOKEN) belum tersedia pada lingkungan pratinjau ini. Fitur penyimpanan dokumen via Vercel Blob perlu diuji setelah deployment ke Vercel.';

function getBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim() || '';
  if (!token || token === 'MY_BLOB_TOKEN' || token === 'MY_BLOB_READ_WRITE_TOKEN') {
    return '';
  }
  return token;
}

export function isBlobConfigured(): boolean {
  return getBlobToken().length > 0;
}

export function getBlobStatus(): { blobConfigured: boolean; message: string | null } {
  const configured = isBlobConfigured();
  return {
    blobConfigured: configured,
    message: configured ? null : PREVIEW_BLOB_NOTICE,
  };
}

export function sanitizeFilename(originalName: string): string {
  const base = path.basename(originalName || 'dokumen.bin');
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'dokumen.bin';
}

export async function persistDocumentBytes(params: {
  buffer: Buffer;
  originalName: string;
  mimeType?: string;
  folder: 'saum-imports' | 'daftar-hadir';
}): Promise<StoredFileResult> {
  const safeFilename = sanitizeFilename(params.originalName);
  const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
  const mimeType = params.mimeType || 'application/octet-stream';
  const pathname = `sipenguji/${params.folder}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeFilename}`;

  const blobToken = getBlobToken();
  if (blobToken) {
    for (const access of ['private', 'public'] as const) {
      try {
        const uploaded = await blobPut(pathname, params.buffer, {
          access,
          contentType: mimeType,
          token: blobToken,
          addRandomSuffix: false,
        });
        return {
          storagePath: uploaded.pathname,
          blobUrl: uploaded.url,
          fileBytes: null,
          mimeType,
          sha256,
          safeFilename,
          storageProvider: 'vercel-blob',
        };
      } catch {
        // Try next access mode or fall back safely to PostgreSQL BYTEA
      }
    }
  }

  return {
    storagePath: `pg-bytea://${pathname}`,
    blobUrl: null,
    fileBytes: params.buffer,
    mimeType,
    sha256,
    safeFilename,
    storageProvider: 'postgres-bytea',
  };
}

export async function loadPersistedDocumentBytes(doc: {
  blob_url?: string | null;
  file_bytes?: Buffer | Uint8Array | null;
  mime_type?: string | null;
  nama_file: string;
}): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
  const filename = sanitizeFilename(doc.nama_file);
  const mimeType = doc.mime_type || 'application/octet-stream';

  if (doc.file_bytes) {
    const buffer = Buffer.isBuffer(doc.file_bytes) ? doc.file_bytes : Buffer.from(doc.file_bytes);
    return { buffer, mimeType, filename };
  }

  const blobToken = getBlobToken();
  if (doc.blob_url && blobToken) {
    for (const access of ['private', 'public'] as const) {
      try {
        const result = await blobGet(doc.blob_url, {
          access,
          token: blobToken,
        });
        if (result && result.statusCode === 200 && result.stream) {
          const arrBuf = await new Response(result.stream).arrayBuffer();
          return {
            buffer: Buffer.from(arrBuf),
            mimeType: result.blob.contentType || mimeType,
            filename,
          };
        }
      } catch {
        // Retry with alternate store access mode if mismatched
      }
    }
  }

  return null;
}
