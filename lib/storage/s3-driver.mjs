/**
 * S3-compatible storage driver.
 *
 * Dziala z dowolnym S3-compatible backendem przez konfigurowalny endpoint:
 *   - AWS S3        -> STORAGE_ENDPOINT pusty lub https://s3.<region>.amazonaws.com
 *   - GCP Storage   -> https://storage.googleapis.com (interoperability)
 *   - MinIO / Ceph  -> https://minio.../  + STORAGE_FORCE_PATH_STYLE=true
 *
 * Uwierzytelnianie:
 *   - Na AWS EC2 z instance role: nie podawaj kluczy (SDK uzyje roli).
 *   - Gdziekolwiek indziej: STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY.
 *
 * SDK ladowany leniwie (dynamic import) — gdy CC dziala na local driverze,
 * @aws-sdk/client-s3 nie jest nigdy importowany.
 */

const KEY_PREFIX = "media/"; // logiczny katalog w buckecie

function cfg() {
  return {
    bucket: process.env.STORAGE_BUCKET,
    region: process.env.STORAGE_REGION || process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    forcePathStyle: String(process.env.STORAGE_FORCE_PATH_STYLE || "false").toLowerCase() === "true",
    accessKeyId: process.env.STORAGE_ACCESS_KEY || undefined,
    secretAccessKey: process.env.STORAGE_SECRET_KEY || undefined,
  };
}

function keyFor(filename) {
  const base = String(filename || "").replace(/^\/+/, "").split("/").pop();
  if (!base || base.includes("..")) throw new Error("Invalid filename");
  return `${KEY_PREFIX}${base}`;
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  // Web ReadableStream (Node 18+) lub Node Readable
  if (typeof stream.transformToByteArray === "function") {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createS3Driver() {
  const c = cfg();
  if (!c.bucket) throw new Error("STORAGE_BUCKET is required when STORAGE_PROVIDER=s3");

  let _clientPromise = null;
  let _lib = null;

  async function client() {
    if (!_clientPromise) {
      _clientPromise = (async () => {
        _lib = await import("@aws-sdk/client-s3");
        const { S3Client } = _lib;
        const opts = {
          region: c.region,
          endpoint: c.endpoint,
          forcePathStyle: c.forcePathStyle,
        };
        // Klucze tylko gdy podane — inaczej SDK uzyje instance role / default chain.
        if (c.accessKeyId && c.secretAccessKey) {
          opts.credentials = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
        }
        return new S3Client(opts);
      })();
    }
    return _clientPromise;
  }

  return {
    kind: "s3",

    async put(filename, buffer, contentType = null) {
      const s3 = await client();
      const { PutObjectCommand } = _lib;
      const Key = keyFor(filename);
      await s3.send(new PutObjectCommand({
        Bucket: c.bucket,
        Key,
        Body: buffer,
        ContentType: contentType || "application/octet-stream",
        CacheControl: "public, max-age=31536000, immutable",
      }));
      // URL pozostaje /media/<filename> — serwowanie idzie przez /api/media,
      // ktory w trybie s3 streamuje z bucketa. Dzieki temu DB/front bez zmian.
      const base = Key.slice(KEY_PREFIX.length);
      return { url: `/media/${base}`, filename: base, size: buffer.length };
    },

    async get(filename, contentType = null) {
      const s3 = await client();
      const { GetObjectCommand } = _lib;
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: c.bucket, Key: keyFor(filename) }));
        const body = await streamToBuffer(out.Body);
        return { body, size: Number(out.ContentLength || body.length), contentType: out.ContentType || contentType };
      } catch (err) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async head(filename) {
      const s3 = await client();
      const { HeadObjectCommand } = _lib;
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: keyFor(filename) }));
        return { size: Number(out.ContentLength || 0), updatedAt: out.LastModified || null };
      } catch (err) {
        if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async remove(filename) {
      const s3 = await client();
      const { DeleteObjectCommand } = _lib;
      await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: keyFor(filename) }));
    },

    async list() {
      const s3 = await client();
      const { ListObjectsV2Command } = _lib;
      const names = [];
      let token;
      do {
        const out = await s3.send(new ListObjectsV2Command({
          Bucket: c.bucket,
          Prefix: KEY_PREFIX,
          ContinuationToken: token,
        }));
        for (const obj of out.Contents || []) {
          const base = String(obj.Key).slice(KEY_PREFIX.length);
          if (base) names.push(base);
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return names;
    },
  };
}
