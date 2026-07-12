import { mkdir, readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const STORAGE_PROVIDERS = {
  LOCAL: "local",
  S3: "s3",
};

const MEDIA_PREFIX = "media";

function joinStorageKey(...parts) {
  return parts
    .map((part) => String(part || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function getStoragePrefix() {
  return process.env.STORAGE_PREFIX || "";
}

export const ALLOWED_MEDIA_CATEGORIES = [
  "audio",
  "documents",
  "images",
  "videos",
  "rcs",
  "whatsapp",
];

let cachedS3Client;

export function getStorageProvider() {
  return (process.env.STORAGE_PROVIDER || STORAGE_PROVIDERS.LOCAL).toLowerCase();
}

export function isS3StorageEnabled() {
  return getStorageProvider() === STORAGE_PROVIDERS.S3;
}

export function getMediaRootDir() {
  return path.join(process.cwd(), "public", "media");
}

export function assertValidMediaCategory(category) {
  if (!ALLOWED_MEDIA_CATEGORIES.includes(category)) {
    throw new Error("Invalid media category");
  }
  return category;
}

export function normalizeMediaFileName(fileName) {
  const raw = Array.isArray(fileName) ? fileName.join("/") : String(fileName || "");

  if (!raw || raw.includes("..") || raw.startsWith("/") || path.isAbsolute(raw)) {
    throw new Error("Invalid media filename");
  }

  return raw;
}

export function getObjectKey(category, fileName) {
  return joinStorageKey(getStoragePrefix(), MEDIA_PREFIX, assertValidMediaCategory(category), normalizeMediaFileName(fileName));
}

export function getMediaServeUrl(category, fileName, baseUrl = "") {
  const encodedPath = normalizeMediaFileName(fileName)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${baseUrl}/api/media/serve/${assertValidMediaCategory(category)}/${encodedPath}`;
}

function getBucketName() {
  if (!process.env.STORAGE_BUCKET) {
    throw new Error("STORAGE_BUCKET is required when STORAGE_PROVIDER=s3");
  }
  return process.env.STORAGE_BUCKET;
}

function getS3Client() {
  if (cachedS3Client) return cachedS3Client;

  const config = {
    region: process.env.STORAGE_REGION || "us-east-1",
    forcePathStyle: String(process.env.STORAGE_FORCE_PATH_STYLE || "false").toLowerCase() === "true",
  };

  if (process.env.STORAGE_ENDPOINT) {
    config.endpoint = process.env.STORAGE_ENDPOINT;
  }

  cachedS3Client = new S3Client(config);
  return cachedS3Client;
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function toFileRecord({ category, fileName, size, createdAt, modifiedAt, baseUrl }) {
  return {
    name: fileName,
    filename: fileName,
    category,
    size: size || 0,
    url: getMediaServeUrl(category, fileName, baseUrl),
    publicPath: `/media/${category}/${fileName}`,
    createdAt,
    modifiedAt,
  };
}

export async function ensureMediaDirectories() {
  if (isS3StorageEnabled()) return;

  for (const category of ALLOWED_MEDIA_CATEGORIES) {
    await mkdir(path.join(getMediaRootDir(), category), { recursive: true });
  }
}

export async function putMediaFile({ category, fileName, buffer, contentType }) {
  assertValidMediaCategory(category);
  const normalizedFileName = normalizeMediaFileName(fileName);

  if (isS3StorageEnabled()) {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getBucketName(),
        Key: getObjectKey(category, normalizedFileName),
        Body: buffer,
        ContentType: contentType || "application/octet-stream",
      })
    );
    return { key: getObjectKey(category, normalizedFileName) };
  }

  const categoryDir = path.join(getMediaRootDir(), category);
  await mkdir(categoryDir, { recursive: true });
  const filePath = path.normalize(path.join(categoryDir, normalizedFileName));

  if (!filePath.startsWith(categoryDir)) {
    throw new Error("Invalid media filename");
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  return { path: filePath };
}

export async function mediaFileExists(category, fileName) {
  assertValidMediaCategory(category);
  const normalizedFileName = normalizeMediaFileName(fileName);

  if (isS3StorageEnabled()) {
    try {
      await getS3Client().send(
        new HeadObjectCommand({
          Bucket: getBucketName(),
          Key: getObjectKey(category, normalizedFileName),
        })
      );
      return true;
    } catch (error) {
      if (["NotFound", "NoSuchKey", "NotFoundError"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  return existsSync(path.join(getMediaRootDir(), category, normalizedFileName));
}

export async function getMediaFile(category, fileName) {
  assertValidMediaCategory(category);
  const normalizedFileName = normalizeMediaFileName(fileName);

  if (isS3StorageEnabled()) {
    try {
      const response = await getS3Client().send(
        new GetObjectCommand({
          Bucket: getBucketName(),
          Key: getObjectKey(category, normalizedFileName),
        })
      );

      const buffer = await streamToBuffer(response.Body);
      return {
        buffer,
        size: Number(response.ContentLength || buffer.length),
        modifiedAt: response.LastModified || new Date(),
        contentType: response.ContentType,
      };
    } catch (error) {
      if (["NoSuchKey", "NotFound"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  const mediaDir = path.join(getMediaRootDir(), category);
  const filePath = path.normalize(path.join(mediaDir, normalizedFileName));

  if (!filePath.startsWith(mediaDir) || !existsSync(filePath)) {
    return null;
  }

  const [buffer, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    buffer,
    size: buffer.length,
    modifiedAt: fileStats.mtime,
    createdAt: fileStats.birthtime,
  };
}

export async function listMediaFiles(category, { baseUrl = "", extensions } = {}) {
  assertValidMediaCategory(category);
  const extensionSet = extensions ? new Set([...extensions].map((ext) => ext.toLowerCase())) : null;
  const acceptsFile = (fileName) => !extensionSet || extensionSet.has(path.extname(fileName).toLowerCase());

  if (isS3StorageEnabled()) {
    const client = getS3Client();
    const bucket = getBucketName();
    const prefix = joinStorageKey(getStoragePrefix(), MEDIA_PREFIX, category) + "/";
    const files = [];
    let ContinuationToken;

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken,
        })
      );

      for (const object of response.Contents || []) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        const fileName = object.Key.slice(prefix.length);
        if (!fileName || !acceptsFile(fileName)) continue;

        files.push(
          toFileRecord({
            category,
            fileName,
            size: object.Size,
            createdAt: object.LastModified,
            modifiedAt: object.LastModified,
            baseUrl,
          })
        );
      }

      ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (ContinuationToken);

    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return files;
  }

  const mediaDir = path.join(getMediaRootDir(), category);
  try {
    await mkdir(mediaDir, { recursive: true });
    const names = await readdir(mediaDir);
    const files = [];

    for (const name of names) {
      const fullPath = path.join(mediaDir, name);
      const fileStats = await stat(fullPath);
      if (!fileStats.isFile() || !acceptsFile(name)) continue;

      files.push(
        toFileRecord({
          category,
          fileName: name,
          size: fileStats.size,
          createdAt: fileStats.birthtime,
          modifiedAt: fileStats.mtime,
          baseUrl,
        })
      );
    }

    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function deleteMediaFile(category, fileName) {
  assertValidMediaCategory(category);
  const normalizedFileName = normalizeMediaFileName(fileName);

  if (isS3StorageEnabled()) {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: getBucketName(),
        Key: getObjectKey(category, normalizedFileName),
      })
    );
    return true;
  }

  const mediaDir = path.join(getMediaRootDir(), category);
  const filePath = path.normalize(path.join(mediaDir, normalizedFileName));

  if (!filePath.startsWith(mediaDir) || !existsSync(filePath)) {
    throw new Error("File not found");
  }

  await unlink(filePath);
  return true;
}
