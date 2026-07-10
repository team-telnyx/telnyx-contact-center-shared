import { input, password as inquirerPassword, confirm as inquirerConfirm, select as inquirerSelect } from '@inquirer/prompts';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';

// Re-exported helper so call sites (wizard, summary) can highlight an
// auto-generated secret without re-importing chalk themselves. Lives here
// (not in wizard.mjs) because the visual style belongs with the rest of the
// UI helpers — keeping color logic in one place avoids drift.
export const chalkGreen = (s) => chalk.green(s);
export const chalkGray = (s) => chalk.gray(s);

// Ported from ~/Documents/dev/fde-infra-cli/src/lib/ui.mjs — same color palette and
// prompt wrapper conventions so the CC deploy wizard feels like FDE CLI.

export const color = {
  title: (value) => chalk.bold.cyan(value),
  subtitle: (value) => chalk.gray(value),
  success: (value) => chalk.green(value),
  warning: (value) => chalk.yellow(value),
  danger: (value) => chalk.red(value),
  muted: (value) => chalk.gray(value),
  accent: (value) => chalk.cyan(value),
};

export function header(title, subtitle = '') {
  const width = Math.max(56, title.length + 6, subtitle.length + 6);
  const line = '═'.repeat(width - 2);
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan('║ ') + chalk.bold.white(title.padEnd(width - 4)) + chalk.cyan(' ║'));
  if (subtitle) console.log(chalk.cyan('║ ') + chalk.gray(subtitle.padEnd(width - 4)) + chalk.cyan(' ║'));
  console.log(chalk.cyan(`╚${line}╝`));
}

export async function ask(question, defaultValue = '') {
  return input({ message: question, default: defaultValue || undefined });
}

export async function askSecret(question, { defaultValue } = {}) {
  return inquirerPassword({ message: question, mask: '*' });
}

export async function confirm(question, defaultValue = true) {
  return inquirerConfirm({ message: question, default: defaultValue });
}

export async function select(title, options, { allowCustom = false, customLabel = 'Custom value' } = {}) {
  if (!options.length && !allowCustom) throw new Error(`No options available for ${title}`);
  const choices = options.map((option) => {
    if (typeof option === 'string') return { name: option, value: option };
    return {
      name: option.label,
      value: option.value,
      description: option.description,
      disabled: option.disabled,
    };
  });
  if (allowCustom) choices.push({ name: customLabel, value: '__custom__' });
  return inquirerSelect({
    message: title,
    choices,
    pageSize: Math.min(Math.max(choices.length, 7), 12),
    loop: false,
  });
}

/**
 * Lightweight sequential progress reporter (not a live TTY spinner — the wizard's
 * output is often piped/logged, so we print discrete status lines instead of
 * animating in place). API mirrors what a spinner would expose so call sites read
 * naturally: step.start(...) -> step.succeed(...) / step.fail(...) / step.warn(...).
 */
export function step(label) {
  console.log(`  ${chalk.gray('⠸')} ${label}`);
  return {
    succeed(message = label) {
      console.log(`  ${chalk.green('✔')} ${message}`);
    },
    fail(message = label) {
      console.log(`  ${chalk.red('✖')} ${message}`);
    },
    warn(message = label) {
      console.log(`  ${chalk.yellow('⚠')} ${message}`);
    },
    info(message) {
      console.log(`      ${chalk.gray(message)}`);
    },
  };
}

/**
 * Animated spinner + elapsed-time indicator for long-running steps (docker build,
 * container pull, network ops). Re-uses the same `step` API so call sites read
 * identically to the non-animated `step()`:
 *
 *   const s = ui.longStep('Building containers (first run can take 1-3 min)...');
 *   try {
 *     await composeUp({ ... });
 *     s.succeed('Containers started');
 *   } catch (err) {
 *     s.fail(`docker compose up failed: ${err.message}`);
 *   }
 *
 * Implementation notes:
 *   - TTY path: rotates a Braille spinner frame every 100ms in-place using
 *     `\r\x1b[K` to overwrite the current line, with `(Ns)` elapsed so the
 *     user can see progress even when docker compose itself is silent.
 *   - non-TTY path: degrades to a one-line log (same as `step()`) — writing
 *     `\r` to a log file would corrupt it.
 *   - After 30s / 60s / 120s / 180s, prints a hint that the step can take a
 *     while, then resumes the spinner on a fresh line.
 *   - Every dependency is injectable (intervalFn, now, write, isTTY) so tests
 *     don't have to wait on real timers.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
// Thresholds (seconds) at which we inject a "still running" hint. Docker build
// of the CC app on first run typically takes 60-180s.
const STILL_RUNNING_THRESHOLDS = [30, 60, 120, 180];

export function longStep(label, {
  intervalMs = SPINNER_INTERVAL_MS,
  isTTY = Boolean(process.stdout && process.stdout.isTTY),
  write = process.stdout.write.bind(process.stdout),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  // When the parent knows an upper bound (e.g. health probe has a 120s budget),
  // pass it here so the spinner shows `(38s/120s)` instead of just `(38s)`.
  // This lets users tell at a glance whether they have time left before the
  // wizard gives up — without it, "Not healthy after 121s" is the first signal
  // that time was running out at all.
  timeoutMs = null,
} = {}) {
  const formatElapsed = (s) => {
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const totalSec = Math.ceil(timeoutMs / 1000);
      return `${s}s/${totalSec}s`;
    }
    return `${s}s`;
  };

  if (!isTTY) {
    // Fallback for non-interactive runs (CI, log files): behave exactly like
    // the plain `step()` helper so callers don't have to branch.
    console.log(`  ${chalk.gray('⠸')} ${label}`);
    return {
      succeed(message = label) { console.log(`  ${chalk.green('✔')} ${message}`); },
      fail(message = label) { console.log(`  ${chalk.red('✖')} ${message}`); },
      warn(message = label) { console.log(`  ${chalk.yellow('⚠')} ${message}`); },
      info(message) { console.log(`      ${chalk.gray(message)}`); },
      stop() {},
    };
  }

  let frame = 0;
  const startedAt = now();
  // Number of thresholds already emitted. We don't compare raw elapsed seconds
  // against the last threshold value because elapsed monotonically grows and a
  // naive `elapsed !== lastThresholdEmitted` would re-emit every tick after the
  // crossing. Counting crossed thresholds instead gives exactly-once semantics.
  let thresholdsEmitted = 0;
  let stopped = false;
  let timer = null;

  function render() {
    const elapsed = Math.floor((now() - startedAt) / 1000);
    const f = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    write(`\r\x1b[K  ${chalk.cyan(f)} ${label}${chalk.gray(` (${formatElapsed(elapsed)})`)}`);
    frame += 1;
    // Emit a "still running" hint when we cross a new threshold, then resume
    // the spinner on a fresh line. Without this, a silent docker build looks
    // frozen at the user's end even though the spinner is animating.
    const crossed = STILL_RUNNING_THRESHOLDS.filter((t) => elapsed >= t).length;
    if (crossed > thresholdsEmitted) {
      write(`\n      ${chalk.gray('(still running — first-run builds can take 1-3 minutes)')}\n`);
      thresholdsEmitted = crossed;
    }
  }

  function clearLine() {
    write('\r\x1b[K');
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    clearLine();
  }

  render();
  timer = setIntervalFn(render, intervalMs);

  return {
    succeed(message = label) {
      const elapsed = Math.floor((now() - startedAt) / 1000);
      stop();
      console.log(`  ${chalk.green('✔')} ${message}${chalk.gray(` (${formatElapsed(elapsed)})`)}`);
    },
    fail(message = label) {
      const elapsed = Math.floor((now() - startedAt) / 1000);
      stop();
      console.log(`  ${chalk.red('✖')} ${message}${chalk.gray(` (${formatElapsed(elapsed)})`)}`);
    },
    warn(message = label) {
      const elapsed = Math.floor((now() - startedAt) / 1000);
      stop();
      console.log(`  ${chalk.yellow('⚠')} ${message}${chalk.gray(` (${formatElapsed(elapsed)})`)}`);
    },
    info(message) {
      // Pause the spinner so the message prints on its own line, then resume.
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
      clearLine();
      console.log(`      ${chalk.gray(message)}`);
      render();
      timer = setIntervalFn(render, intervalMs);
    },
    stop,
  };
}

export function checkLine(status, label, detail = '') {
  const icon = status === 'ok' ? chalk.green('✔') : status === 'warn' ? chalk.yellow('⚠') : chalk.red('✖');
  const line = detail ? `${label}  ${chalk.gray(detail)}` : label;
  console.log(`  ${icon} ${line}`);
}

/**
 * Writes auto-generated secrets (currently just the owner password when the
 * user picked "leave blank to auto-generate") to a sibling file inside the
 * deploy dir, chmod 600. The wizard prints the values on screen too, but a
 * file is the durable artifact — if the user clears their terminal or runs
 * the wizard unattended (in CI / a fresh shell), they still need a way to
 * retrieve the credentials. Keeping it next to .cc-state.json means the
 * deploy dir is self-contained.
 *
 * Format is plain text (`KEY=value\n...`) with a leading `# Generated by cc up`
 * marker so future runs can detect that the file is owned by the wizard (and
 * so the user knows not to commit it — .cc-credentials.txt is in .gitignore
 * alongside .env).
 *
 * Errors are intentionally swallowed (logged, not thrown): if the host is
 * read-only or chmod is not supported (Windows), the on-screen output is
 * still the source of truth.
 */
export async function persistGeneratedSecrets({ deployDir, generatedSecrets, writeFileImpl = writeFile, chmodImpl = chmod, log = console.log }) {
  if (!deployDir || !generatedSecrets || Object.keys(generatedSecrets).length === 0) return;
  const target = join(deployDir, '.cc-credentials.txt');
  const lines = [
    `# Generated by cc up — ${new Date().toISOString()}`,
    `# DO NOT COMMIT. Contains owner-password-equivalent secrets.`,
    '',
  ];
  for (const [name, value] of Object.entries(generatedSecrets)) {
    lines.push(`${name}=${value}`);
  }
  const body = lines.join('\n') + '\n';
  try {
    await writeFileImpl(target, body, { encoding: 'utf8', mode: 0o600 });
    try { await chmodImpl(target, 0o600); } catch { /* mode on writeFile is sufficient on POSIX */ }
  } catch (err) {
    log(`  ⚠ Could not persist generated secrets to ${target}: ${err.message}`);
    log('      (The values were printed on screen — copy them now or lose them.)');
  }
}
