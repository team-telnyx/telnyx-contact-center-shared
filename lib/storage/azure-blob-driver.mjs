/**
 * Azure Blob Storage driver.
 *
 * Azure Blob Storage has NO S3-compatible API (unlike GCS's interoperability
 * mode, which the s3-driver.mjs already covers via a configurable endpoint)
 * — different protocol, different auth model. This is a genuinely separate
 * driver using the official @azure/storage-blob SDK, not another branch of
 * s3-driver.mjs's cfg()/client().
 *
 * Uwierzytelnianie (w kolejności prawdopodobienstwa):
 *   1. AZURE_STORAGE_CONNECTION_STRING  — najprostsze, ustawiane przez
 *      cc-storage-azure's Key Vault secret (patrz cloud-init.sh.tpl). Dziala
 *      wszedzie, w tym lokalnie do testow.
 *   2. Managed Identity (DefaultAzureCredential) — gdy connection string nie
 *      jest ustawiony, ale STORAGE_ACCOUNT jest. To jest docelowa sciezka
 *      auth na samej VM (az-cloud wizard nadaje Storage Blob Data
 *      Contributor roli tozsamosci VM — patrz cc-compute-single-azure) —
 *      brak sekretow w ogole, identycznie jak instance role na AWS.
 *
 * SDK ladowany leniwie (dynamic import) — gdy CC dziala na local/s3
 * driverze, @azure/storage-blob i @azure/identity nigdy nie sa importowane.
 */

function joinKeyPrefix(...parts) {
  const joined = parts
    .map((part) => String(part || "").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return joined ? `${joined}/` : "";
}

function mediaKeyPrefix() {
  return joinKeyPrefix(process.env.STORAGE_PREFIX, "media");
}

function cfg() {
  return {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
    accountName: process.env.STORAGE_ACCOUNT || undefined,
    containerName: process.env.STORAGE_CONTAINER || process.env.STORAGE_BUCKET,
  };
}

function keyFor(filename) {
  const base = String(filename || "").replace(/^\/+/, "").split("/").pop();
  if (!base || base.includes("..")) throw new Error("Invalid filename");
  return `${mediaKeyPrefix()}${base}`;
}

async function streamToBuffer(readableStream) {
  if (!readableStream) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of readableStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createAzureBlobDriver() {
  const c = cfg();
  if (!c.containerName) throw new Error("STORAGE_CONTAINER (or STORAGE_BUCKET) is required when STORAGE_PROVIDER=azure");
  if (!c.connectionString && !c.accountName) {
    throw new Error("Either AZURE_STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT (for Managed Identity auth) is required when STORAGE_PROVIDER=azure");
  }

  let _containerClientPromise = null;

  async function containerClient() {
    if (!_containerClientPromise) {
      _containerClientPromise = (async () => {
        const { BlobServiceClient } = await import("@azure/storage-blob");
        let serviceClient;
        if (c.connectionString) {
          serviceClient = BlobServiceClient.fromConnectionString(c.connectionString);
        } else {
          // Managed Identity path — no keys anywhere. DefaultAzureCredential
          // walks env vars -> Managed Identity -> az CLI in that order; on
          // the VM this deployment provisions, the User-Assigned Managed
          // Identity attached by cc-compute-single-azure (Storage Blob Data
          // Contributor role, scoped to this deployment's own Storage
          // Account only) is what actually gets used.
          const { DefaultAzureCredential } = await import("@azure/identity");
          serviceClient = new BlobServiceClient(
            `https://${c.accountName}.blob.core.windows.net`,
            new DefaultAzureCredential(),
          );
        }
        return serviceClient.getContainerClient(c.containerName);
      })();
    }
    return _containerClientPromise;
  }

  return {
    kind: "azure",

    async put(filename, buffer, contentType = null) {
      const container = await containerClient();
      const Key = keyFor(filename);
      const blockBlobClient = container.getBlockBlobClient(Key);
      await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: {
          blobContentType: contentType || "application/octet-stream",
          blobCacheControl: "public, max-age=31536000, immutable",
        },
      });
      const prefix = mediaKeyPrefix();
      const base = Key.slice(prefix.length);
      return { url: `/media/${base}`, filename: base, size: buffer.length };
    },

    async get(filename, contentType = null) {
      const container = await containerClient();
      const blockBlobClient = container.getBlockBlobClient(keyFor(filename));
      try {
        const download = await blockBlobClient.download();
        const body = await streamToBuffer(download.readableStreamBody);
        return {
          body,
          size: Number(download.contentLength || body.length),
          contentType: download.contentType || contentType,
        };
      } catch (err) {
        if (err?.statusCode === 404 || err?.code === "BlobNotFound") return null;
        throw err;
      }
    },

    async head(filename) {
      const container = await containerClient();
      const blockBlobClient = container.getBlockBlobClient(keyFor(filename));
      try {
        const props = await blockBlobClient.getProperties();
        return { size: Number(props.contentLength || 0), updatedAt: props.lastModified || null };
      } catch (err) {
        if (err?.statusCode === 404 || err?.code === "BlobNotFound") return null;
        throw err;
      }
    },

    async remove(filename) {
      const container = await containerClient();
      const blockBlobClient = container.getBlockBlobClient(keyFor(filename));
      await blockBlobClient.deleteIfExists();
    },

    async list() {
      const container = await containerClient();
      const prefix = mediaKeyPrefix();
      const names = [];
      for await (const blob of container.listBlobsFlat({ prefix })) {
        const base = String(blob.name).slice(prefix.length);
        if (base) names.push(base);
      }
      return names;
    },
  };
}
