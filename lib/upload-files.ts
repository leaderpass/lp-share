/**
 * Client upload file rules, shared by the page and the API. Clients send
 * camera originals (.mxf, .braw, .r3d…) that browsers report with no MIME type,
 * so there's no allow list: only executables/scripts are refused.
 */

export const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.dll', '.com',
  '.scr', '.vbs', '.js', '.jar', '.php', '.py', '.rb', '.pl', '.app', '.dmg', '.pkg',
]);

/** Sanity cap per file. */
export const MAX_FILE_BYTES = 2 * 1024 ** 4;   // 2 TB

const MIN_PART = 64 * 1024 * 1024;
const MAX_PARTS = 9_000;   // S3/R2 limit is 10,000

/** Part size for a file: 64 MB, larger when the file would need too many parts. */
export function partSizeFor(size: number): number {
  const mb = 1024 * 1024;
  return Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / mb) * mb);
}

export function partCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mxf': 'application/mxf', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.m4a': 'audio/x-m4a', '.ogg': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

/** The browser's type, else one from the extension, else octet-stream. */
export function mimeFor(name: string, browserType: string | null | undefined): string {
  const t = (browserType ?? '').trim().toLowerCase();
  if (t && t !== 'application/octet-stream' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t)) return t;
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

export type FileKind = 'video' | 'audio' | 'image' | 'document' | 'other';

const DOC_EXT = new Set(['.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pages', '.key', '.numbers', '.rtf']);
const VIDEO_EXT = new Set(['.mxf', '.braw', '.r3d', '.mts', '.m2ts', '.mov', '.mp4', '.mkv', '.avi', '.m4v', '.webm']);

export function kindOf(name: string, mime: string): FileKind {
  const ext = extensionOf(name);
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (DOC_EXT.has(ext) || mime.startsWith('text/')) return 'document';
  return 'other';
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'file';
}
