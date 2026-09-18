/**
 * Local filesystem storage driver.
 *
 * Zachowuje DOKLADNIE dotychczasowe zachowanie CC: pliki w public/media,
 * URL w formie /media/<filename>. To jest domyslny driver — gdy STORAGE_PROVIDER
 * nie jest ustawione, CC (w tym PROD single-node) dziala jak dotychczas.
 */
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PUBLIC_PREFIX = "/media";

// Liczone leniwie (nie na module-load), zeby respektowac biezacy process.cwd()
// — wazne dla testow (chdir na temp) i przewidywalnosci w runtime.
function mediaDir() {
  return path.join(process.cwd(), "public", "media");
}

function safeFullPath(filename) {
  const base = path.basename(String(filename || ""));
  if (!base || base.includes("..") || base.includes("/") || base.includes("\\")) return null;
  const dir = mediaDir();
  const full = path.join(dir, base);
  return full.startsWith(dir) ? full : null;
}

export function createLocalDriver() {
  return {
    kind: "local",

    /** Zapis pliku. Zwraca { url, filename, size }. */
    async put(filename, buffer /*, contentType */) {
      const dir = mediaDir();
      await mkdir(dir, { recursive: true });
      const full = safeFullPath(filename);
      if (!full) throw new Error("Invalid filename");
      await writeFile(full, buffer);
      return { url: `${PUBLIC_PREFIX}/${path.basename(full)}`, filename: path.basename(full), size: buffer.length };
    },

    /** Odczyt pliku. Zwraca { body: Buffer, size, contentType } lub null jesli brak. */
    async get(filename, contentType = null) {
      const full = safeFullPath(filename);
      if (!full) return null;
      try {
        const [body, s] = await Promise.all([
          readFile(/* turbopackIgnore: true */ full),
          stat(/* turbopackIgnore: true */ full),
        ]);
        return { body, size: s.size, contentType };
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      }
    },

    /** Fragment pliku (bajty start..end wlacznie) bez czytania calosci. */
    async getRange(filename, start, end) {
      const full = safeFullPath(filename);
      if (!full) return null;
      let handle;
      try {
        handle = await open(/* turbopackIgnore: true */ full, "r");
        const length = Math.max(0, end - start + 1);
        const body = Buffer.alloc(length);
        const { bytesRead } = await handle.read(body, 0, length, start);
        return { body: bytesRead === length ? body : body.subarray(0, bytesRead) };
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      } finally {
        await handle?.close();
      }
    },

    /** Metadane bez czytania zawartosci. Zwraca { size } lub null. */
    async head(filename) {
      const full = safeFullPath(filename);
      if (!full) return null;
      try {
        const s = await stat(/* turbopackIgnore: true */ full);
        return { size: s.size, updatedAt: s.mtime };
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
      }
    },

    /** Usuniecie pliku. Idempotentne (ENOENT ignorowane). */
    async remove(filename) {
      const full = safeFullPath(filename);
      if (!full) return;
      await unlink(full).catch((err) => {
        if (err?.code !== "ENOENT") throw err;
      });
    },

    /** Lista nazw plikow w katalogu media. */
    async list() {
      const dir = mediaDir();
      await mkdir(dir, { recursive: true });
      return readdir(dir);
    },
  };
}
