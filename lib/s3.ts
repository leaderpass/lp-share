import 'server-only';
import crypto from 'node:crypto';

/**
 * The client uploads bucket (spec §12.3): multipart uploads straight from the
 * browser. Hand-rolled AWS SigV4 like lib/r2.ts (no SDK); R2 uses region
 * "auto". Env: R2_CLIENT_UPLOADS_BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY,
 * endpoint R2_CLIENT_UPLOADS_ENDPOINT or R2_ENDPOINT. This token is scoped to
 * this one bucket.
 */

interface Cfg { endpoint: string; bucket: string; accessKey: string; secretKey: string }

function cfg(): Cfg | null {
  const endpoint = (process.env.R2_CLIENT_UPLOADS_ENDPOINT || process.env.R2_ENDPOINT || '').replace(/\/$/, '');
  const bucket = process.env.R2_CLIENT_UPLOADS_BUCKET ?? '';
  const accessKey = process.env.R2_CLIENT_UPLOADS_ACCESS_KEY_ID ?? '';
  const secretKey = process.env.R2_CLIENT_UPLOADS_SECRET_ACCESS_KEY ?? '';
  return endpoint && bucket && accessKey && secretKey ? { endpoint, bucket, accessKey, secretKey } : null;
}

export function uploadsConfigured(): boolean {
  return cfg() !== null;
}

function need(): Cfg {
  const c = cfg();
  if (!c) throw new Error('client uploads bucket is not configured');
  return c;
}

/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone; SigV4 must not). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

function stamp(): { amzDate: string; dateStamp: string; scope: string } {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp, scope: `${dateStamp}/auto/s3/aws4_request` };
}

function signature(secretKey: string, dateStamp: string, stringToSign: string): string {
  let key = hmac(`AWS4${secretKey}`, dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) key = hmac(key, part);
  return crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
}

const objectPath = (c: Cfg, key: string) => `/${[c.bucket, ...key.split('/')].map(rfc3986).join('/')}`;
const canonicalQuery = (q: Record<string, string>) =>
  Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');

/** Presigned PUT for one part of a multipart upload. */
export function presignPart(key: string, multipartId: string, partNumber: number, expiresIn = 6 * 3600): string {
  const c = need();
  const url = new URL(c.endpoint);
  const { amzDate, dateStamp, scope } = stamp();
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
    partNumber: String(partNumber),
    uploadId: multipartId,
  };
  const path = objectPath(c, key);
  const cq = canonicalQuery(query);
  const req = ['PUT', path, cq, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(req)].join('\n');
  return `${url.origin}${path}?${cq}&X-Amz-Signature=${signature(c.secretKey, dateStamp, sts)}`;
}

/** A header-signed request against the bucket. */
async function call(method: string, key: string, query: Record<string, string>, body?: string, headers: Record<string, string> = {}): Promise<Response> {
  const c = need();
  const url = new URL(c.endpoint);
  const { amzDate, dateStamp, scope } = stamp();
  const payloadHash = sha256hex(body ?? '');
  const all: Record<string, string> = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signed = names.join(';');
  const path = objectPath(c, key);
  const cq = canonicalQuery(query);
  const req = [method, path, cq, canonHeaders, signed, payloadHash].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(req)].join('\n');
  const auth = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature(c.secretKey, dateStamp, sts)}`;
  const { host: _host, ...sendHeaders } = lower;
  return fetch(`${url.origin}${path}${cq ? `?${cq}` : ''}`, {
    method, body, headers: { ...sendHeaders, authorization: auth }, cache: 'no-store',
  });
}

async function ok(res: Response, what: string): Promise<string> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${text.slice(0, 200)}`);
  return text;
}

const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const xml = await ok(await call('POST', key, { uploads: '' }, undefined, { 'content-type': contentType }), 'CreateMultipartUpload');
  const id = xmlValue(xml, 'UploadId');
  if (!id) throw new Error('CreateMultipartUpload: no UploadId');
  return id;
}

/** Parts R2 already has (for resuming). */
export async function listParts(key: string, multipartId: string): Promise<Array<{ n: number; etag: string; size: number }>> {
  const out: Array<{ n: number; etag: string; size: number }> = [];
  let marker = '';
  for (;;) {
    const q: Record<string, string> = { uploadId: multipartId, 'max-parts': '1000' };
    if (marker) q['part-number-marker'] = marker;
    const xml = await ok(await call('GET', key, q), 'ListParts');
    for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      out.push({ n: Number(xmlValue(m[1], 'PartNumber')), etag: (xmlValue(m[1], 'ETag') ?? '').replace(/&quot;/g, '"'), size: Number(xmlValue(m[1], 'Size')) });
    }
    if (xmlValue(xml, 'IsTruncated') !== 'true') return out;
    marker = xmlValue(xml, 'NextPartNumberMarker') ?? '';
    if (!marker) return out;
  }
}

export async function completeMultipart(key: string, multipartId: string, parts: Array<{ n: number; etag: string }>): Promise<void> {
  const body = `<CompleteMultipartUpload>${parts
    .sort((a, b) => a.n - b.n)
    .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  const xml = await ok(await call('POST', key, { uploadId: multipartId }, body, { 'content-type': 'application/xml' }), 'CompleteMultipartUpload');
  // R2/S3 can answer 200 with an <Error> body.
  if (/<Error>/.test(xml)) throw new Error(`CompleteMultipartUpload failed: ${xmlValue(xml, 'Message') ?? xml.slice(0, 200)}`);
}

export async function abortMultipart(key: string, multipartId: string): Promise<void> {
  const res = await call('DELETE', key, { uploadId: multipartId });
  if (!res.ok && res.status !== 404) await ok(res, 'AbortMultipartUpload');
}

export async function headObject(key: string): Promise<{ size: number } | null> {
  const res = await call('HEAD', key, {});
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HeadObject failed: ${res.status}`);
  return { size: Number(res.headers.get('content-length') ?? 0) };
}

export async function deleteObject(key: string): Promise<void> {
  const res = await call('DELETE', key, {});
  if (!res.ok && res.status !== 404) await ok(res, 'DeleteObject');
}
