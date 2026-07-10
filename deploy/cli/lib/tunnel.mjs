// Cloudflare "quick tunnel" automation for the Local target.
//
// When the user leaves the "Public domain" prompt blank, the wizard can't
// give Telnyx a reachable HTTPS webhook URL for a laptop behind NAT — so
// instead of shipping a manual "go run this command yourself" step (the old
// README-only flow, which nobody actually followed through on and which never
// updated the Telnyx webhook afterward anyway), we spawn `cloudflared tunnel
// --url http://localhost:<port>` ourselves, parse the randomly-assigned
// `https://<words>.trycloudflare.com` URL out of its log output, and feed that
// straight into envgen + the Telnyx bootstrap step as `baseUrl`.
//
// Key properties:
//   - The tunnel process is spawned `detached` (new session, decoupled from
//     the wizard's controlling terminal) and `unref()`'d so it keeps running
//     after `cc up` exits — the user needs the tunnel alive for as long as
//     they want to receive calls, not just for the duration of the wizard.
//   - stdout/stderr go straight to a log file via a raw fd (not a Node pipe),
//     so nothing keeps our own event loop alive — we poll the file instead of
//     listening for 'data' events.
//   - Quick tunnels have NO stable URL: every fresh `cloudflared` process gets
//     a new random subdomain. There is no way to request the same hostname
//     twice. Callers must re-run the Telnyx webhook update whenever a new
//     tunnel is started (already safe/cheap since upsertVoiceApp is a
//     find-by-name-then-PATCH).
//   - A single quick tunnel proxies exactly ONE local port. It cannot forward
//     both 3000 (HTTP webhooks) and 3001 (WS streaming) at once — confirmed
//     against real `cloudflared` output. The default seeded call flow
//     (lib/default-call-flow-template.mjs: incoming_call -> answer -> speak ->
//     hangup) never touches streaming, so auto-tunneling only port 3000 is
//     sufficient out of the box; flows that add streaming/AI nodes need a
//     real domain or a named (authenticated) Cloudflare tunnel instead.

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const QUICK_TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Spawns `cloudflared tunnel --url http://localhost:<port>` detached, and
 * resolves once the assigned https://*.trycloudflare.com URL shows up in its
 * log output (or rejects on timeout / early process exit).
 */
export async function startQuickTunnel({
  port,
  logPath,
  cloudflaredBin = 'cloudflared',
  spawnImpl = spawn,
  timeoutMs = 45_000,
  pollIntervalMs = 300,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readFileImpl = readFile,
} = {}) {
  if (!port) throw new Error('startQuickTunnel requires { port }');
  if (!logPath) throw new Error('startQuickTunnel requires { logPath }');

  // Truncate (not append) on every spawn: if a previous tunnel's log is still
  // on disk (e.g. resume after the old cloudflared process died), appending
  // would let the URL regex below match the STALE hostname from the old run
  // before the freshly-spawned process has had a chance to log its own —
  // pointing the health check / Telnyx webhook at a dead tunnel.
  const fd = openSync(logPath, 'w');
  let child;
  try {
    child = spawnImpl(cloudflaredBin, ['tunnel', '--url', `http://localhost:${port}`], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  // Detach fully: the wizard process can exit (or Ctrl-C can stop it) without
  // taking the tunnel down with it. `unref()` also keeps our own event loop
  // from waiting on this child.
  child.unref();

  const start = now();
  while (now() - start < timeoutMs) {
    let contents = '';
    try {
      contents = await readFileImpl(logPath, 'utf8');
    } catch {
      // Log file may not have been flushed to yet — keep polling.
    }
    const match = contents.match(QUICK_TUNNEL_URL_REGEX);
    if (match) {
      return { url: match[0], pid: child.pid, logPath };
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `cloudflared exited early (code ${child.exitCode}) before reporting a tunnel URL — see ${logPath}`,
      );
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for cloudflared to report a tunnel URL — see ${logPath}`);
}

/** True if a process with this pid is still alive (best-effort, POSIX). */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort SIGTERM to a tracked tunnel pid. Returns true if a signal was sent. */
export function stopTunnel(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
