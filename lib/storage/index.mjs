/**
 * Storage abstraction — wybiera driver na podstawie STORAGE_PROVIDER.
 *
 *   STORAGE_PROVIDER nieustawione | "local"  -> local filesystem (DOMYSLNE)
 *   STORAGE_PROVIDER = "s3"                   -> S3-compatible (AWS S3, GCS interop)
 *   STORAGE_PROVIDER = "azure"                -> Azure Blob Storage
 *
 * Dzieki temu PROD CC (single-node, bez ENV) dziala jak dotychczas — zapis na
 * dysk — a srodowiska HA (multi-node) ustawiaja STORAGE_PROVIDER=s3 i wspoldziela
 * pliki przez bucket. Ten sam codebase, zero zmian zachowania dla PROD.
 *
 * Azure Blob Storage ma osobny driver (nie kolejna galaz s3-driver.mjs),
 * bo nie ma natywnego S3-compatible API (w przeciwienstwie do GCS, ktore ma
 * tryb interoperability) — inny protokol, inny model auth (connection
 * string / Managed Identity zamiast access-key/secret-key HMAC). Patrz
 * azure-blob-driver.mjs.
 *
 * Kontrakt drivera:
 *   put(filename, buffer, contentType?) -> { url, filename, size }
 *   get(filename, contentType?)         -> { body: Buffer, size, contentType } | null
 *   head(filename)                      -> { size, updatedAt? } | null
 *   remove(filename)                    -> void
 *   list()                              -> string[]  (nazwy plikow)
 *   kind                                -> "local" | "s3" | "azure"
 */
import { createLocalDriver } from "./local-driver.mjs";

let _driver = null;

export function getStorageProvider() {
  return String(process.env.STORAGE_PROVIDER || "local").toLowerCase();
}

export function isS3Storage() {
  return getStorageProvider() === "s3";
}

export function isAzureStorage() {
  return getStorageProvider() === "azure";
}

/**
 * Zwraca singleton drivera. S3/Azure driver ladowany leniwie, zeby local-only
 * deploye nie wymagaly @aws-sdk/client-s3 ani @azure/storage-blob w runtime.
 */
export async function getStorage() {
  if (_driver) return _driver;
  if (isS3Storage()) {
    const { createS3Driver } = await import("./s3-driver.mjs");
    _driver = createS3Driver();
  } else if (isAzureStorage()) {
    const { createAzureBlobDriver } = await import("./azure-blob-driver.mjs");
    _driver = createAzureBlobDriver();
  } else {
    _driver = createLocalDriver();
  }
  return _driver;
}

/** Wylacznie do testow — resetuje singleton. */
export function __resetStorageForTests() {
  _driver = null;
}
