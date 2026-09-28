import 'server-only';
import crypto from 'node:crypto';

/**
 * Presigned R2 GETs for share downloads (AWS SigV4 query auth, hand-rolled so
 * no SDK is needed; R2 accepts region "auto"). Ported from LPOS
 * lib/services/share-r2.ts. Clients download straight from R2 — nothing streams
 * through this app. Env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */

export function isR2Configured(): boolean {
  return !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone; SigV4 must not). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string) => crypto.createHash('sha256').update(data).digest('hex');

/** A URL that downloads `key` for `expiresIn` seconds, saved as `filename`. */
export function presignR2Get(key: string, filename: string, expiresIn = 4 * 3600): string {
  const endpoint = (process.env.R2_ENDPOINT ?? '').replace(/\/$/, '');
  const accessKey = process.env.R2_ACCESS_KEY_ID ?? '';
  const secretKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = process.env.R2_BUCKET ?? '';

  const url = new URL(endpoint);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const canonicalUri = `/${[bucket, ...key.split('/')].map(rfc3986).join('/')}`;
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
    'response-content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${rfc3986(filename)}`,
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac(`AWS4${secretKey}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'video';
}
