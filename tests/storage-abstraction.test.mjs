import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL("../", import.meta.url);

// ---------------------------------------------------------------------------
// Helper: uruchom blok z podmienionym process.cwd() i ENV, potem przywroc.
// ---------------------------------------------------------------------------
async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Selektor: brak ENV -> local (krytyczne dla PROD single-node).
// ---------------------------------------------------------------------------
test("getStorage() defaults to local driver when STORAGE_PROVIDER is unset (PROD safe)", async () => {
  const mod = await import("../lib/storage/index.mjs");
  await withEnv({ STORAGE_PROVIDER: undefined }, async () => {
    mod.__resetStorageForTests();
    assert.equal(mod.getStorageProvider(), "local");
    assert.equal(mod.isS3Storage(), false);
    const storage = await mod.getStorage();
    assert.equal(storage.kind, "local");
  });
  mod.__resetStorageForTests();
});

test("getStorage() selects s3 driver when STORAGE_PROVIDER=s3", async () => {
  const mod = await import("../lib/storage/index.mjs");
  await withEnv({ STORAGE_PROVIDER: "s3", STORAGE_BUCKET: "test-bucket", STORAGE_REGION: "us-east-2" }, async () => {
    mod.__resetStorageForTests();
    assert.equal(mod.isS3Storage(), true);
    const storage = await mod.getStorage();
    assert.equal(storage.kind, "s3");
  });
  mod.__resetStorageForTests();
});

test("s3 driver throws clear error when STORAGE_BUCKET missing", async () => {
  const { createS3Driver } = await import("../lib/storage/s3-driver.mjs");
  await withEnv({ STORAGE_BUCKET: undefined }, async () => {
    assert.throws(() => createS3Driver(), /STORAGE_BUCKET is required/);
  });
});

// ---------------------------------------------------------------------------
// 2. Local driver: pelny roundtrip put/get/head/remove/list na temp dir.
// ---------------------------------------------------------------------------
test("local driver: put/get/head/remove/list roundtrip", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cc-storage-"));
  const origCwd = process.cwd();
  try {
    process.chdir(tmp);
    const { createLocalDriver } = await import("../lib/storage/local-driver.mjs");
    const driver = createLocalDriver();

    const buf = Buffer.from("hello-image-bytes");
    const saved = await driver.put("logo-abc123.png", buf, "image/png");
    assert.equal(saved.url, "/media/logo-abc123.png");
    assert.equal(saved.filename, "logo-abc123.png");
    assert.equal(saved.size, buf.length);

    const got = await driver.get("logo-abc123.png", "image/png");
    assert.ok(got, "file should be retrievable");
    assert.equal(Buffer.compare(got.body, buf), 0);
    assert.equal(got.size, buf.length);

    const head = await driver.head("logo-abc123.png");
    assert.equal(head.size, buf.length);

    const list = await driver.list();
    assert.ok(list.includes("logo-abc123.png"));

    await driver.remove("logo-abc123.png");
    assert.equal(await driver.get("logo-abc123.png"), null);
    assert.equal(await driver.head("logo-abc123.png"), null);
  } finally {
    process.chdir(origCwd);
    await rm(tmp, { recursive: true, force: true });
  }
});

test("local driver: path traversal in filename cannot escape media dir", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cc-storage-trav-"));
  const origCwd = process.cwd();
  try {
    process.chdir(tmp);
    const { createLocalDriver } = await import("../lib/storage/local-driver.mjs");
    const driver = createLocalDriver();
    // basename-stripping neutralizuje traversal: zapis trafia do public/media/passwd,
    // NIGDY poza katalog media. Odczyt tej samej traversal-sciezki tez sprowadza
    // sie do basename "passwd" wewnatrz media — wiec nie da sie wyjsc poza katalog.
    const saved = await driver.put("../../etc/passwd", Buffer.from("x"), "image/png");
    assert.equal(saved.filename, "passwd", "must strip traversal to basename");
    assert.equal(saved.url, "/media/passwd");
    // Plik istnieje WEWNATRZ media (nie poza), wiec /etc/passwd na hoscie nietkniete.
    const escaped = await import("node:fs/promises").then((m) => m.readFile("/etc/passwd", "utf8").catch(() => "UNREADABLE"));
    assert.notEqual(escaped, "x", "host /etc/passwd must NOT be overwritten");
    const got = await driver.get("../../etc/passwd"); // -> basename passwd w media
    assert.ok(got, "resolves to basename inside media, never outside");
    assert.equal(Buffer.compare(got.body, Buffer.from("x")), 0);
  } finally {
    process.chdir(origCwd);
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. S3 driver: keying / prefiks (bez realnego AWS — sprawdzamy strukture).
// ---------------------------------------------------------------------------
test("s3 driver: builds /media/<file> url and uses configurable media key prefix", async () => {
  // put zwraca url /media/<base>, klucz ma domyślny prefix media/ i opcjonalny STORAGE_PREFIX.
  const src = await readFile(new URL("lib/storage/s3-driver.mjs", repoRoot), "utf8");
  assert.match(src, /function mediaKeyPrefix\(\)/);
  assert.match(src, /process\.env\.STORAGE_PREFIX/);
  assert.match(src, /joinKeyPrefix\(process\.env\.STORAGE_PREFIX, "media"\)/);
  assert.match(src, /url: `\/media\/\$\{base\}`/);
  // Klucze tylko gdy podane -> inaczej instance role
  assert.match(src, /if \(c\.accessKeyId && c\.secretAccessKey\)/);
  // SDK ladowany leniwie
  assert.match(src, /await import\("@aws-sdk\/client-s3"\)/);
});

// ---------------------------------------------------------------------------
// 4. Guard zrodlowy: route'y NIE hardcoduja juz fs writeFile/unlink na media.
//    To zabezpiecza przed regresja "ktos cofnal abstrakcje".
// ---------------------------------------------------------------------------
test("forms/media route uses storage abstraction (no direct fs writeFile/unlink)", async () => {
  const src = await readFile(new URL("app/api/admin/forms/media/route.js", repoRoot), "utf8");
  assert.match(src, /from "@\/lib\/storage\/index\.mjs"/, "must import storage abstraction");
  assert.match(src, /getStorage\(\)/, "must use getStorage()");
  assert.doesNotMatch(src, /\bwriteFile\s*\(/, "must not call writeFile directly");
  assert.doesNotMatch(src, /\bunlink\s*\(/, "must not call unlink directly");
});

test("media serving route uses storage abstraction (no direct fs readFile of MEDIA_DIR)", async () => {
  const src = await readFile(new URL("app/api/media/[...path]/route.js", repoRoot), "utf8");
  assert.match(src, /from "@\/lib\/storage\/index\.mjs"/, "must import storage abstraction");
  assert.match(src, /storage\.get\(/, "must serve via storage.get()");
  assert.doesNotMatch(src, /const MEDIA_DIR =/, "must not hardcode MEDIA_DIR disk path");
});
