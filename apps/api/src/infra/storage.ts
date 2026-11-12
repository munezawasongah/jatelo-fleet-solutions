import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { logger } from '../logger.js';

const base: S3ClientConfig = {
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  },
  // Keep presigned URLs free of SDK checksum parameters so browsers/phones can upload with a plain PUT (MinIO and R2 compatible).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
};
/** Server-side operations (inside the private network on Railway). */
const s3 = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
/** Signs URLs with the host that browsers and phones can reach. */
const signer = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT });
const Bucket = config.S3_BUCKET;

export const UPLOAD_URL_TTL_S = 600;
export const DOWNLOAD_URL_TTL_S = 300;

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
    logger.info({ bucket: Bucket }, 'storage bucket created');
  }
}

export const checkStorage = (): Promise<unknown> => s3.send(new HeadBucketCommand({ Bucket }));

export const presignUpload = (key: string, contentType: string): Promise<string> =>
  getSignedUrl(signer, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
    expiresIn: UPLOAD_URL_TTL_S,
  });

export function presignDownload(
  key: string,
  fileName: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<string> {
  const safe = fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'file';
  return getSignedUrl(
    signer,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: `${disposition}; filename="${safe}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_S },
  );
}

export async function headObject(
  key: string,
): Promise<{ size: number; contentType: string } | null> {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return {
      size: r.ContentLength ?? 0,
      contentType: (r.ContentType ?? '').split(';')[0]!.trim().toLowerCase(),
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/** Downloads an object fully (imports and report attachments; keep to small files). */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

/** Uploads server-generated content (reports, invoices). */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}
