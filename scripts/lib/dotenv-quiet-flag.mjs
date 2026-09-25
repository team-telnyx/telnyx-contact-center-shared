// Silences dotenv for entrypoints whose stdout is machine-readable.
//
// Import this immediately BEFORE `dotenv/config`, and import both before
// anything that reads process.env while being evaluated. Two orderings matter
// here and neither is obvious:
//
// 1. `dotenv/config` calls config() when it is evaluated, and static imports
//    are evaluated before the importing module's body — so the flag cannot be
//    set in that body, nor in this module after an import of `dotenv/config`.
//    A separate module imported first is the only way to set it in time.
// 2. `lib/postgres.mjs` builds its logger at module scope from LOG_LEVEL and
//    LOG_DB_LEVEL, so .env has to be in process.env before that import is
//    evaluated. Loading dotenv from a module body instead of an import would
//    put it after, and those settings would silently fall back to defaults.
//
// Why the flag rather than config({ quiet: true }) directly: DOTENV_CONFIG_QUIET
// wins over the option (verified against 17.4.2), and calling config() by hand
// would drop the other preload options `dotenv/config` translates —
// DOTENV_CONFIG_PATH above all, which selects which .env is read. For a script
// that can reset a database, reading the wrong .env is worse than a noisy log.
//
// Since v17 dotenv can print "injected env (N) from .env" to STDOUT, which is
// where these scripts write their JSON: one stray line and the output no longer
// parses.
process.env.DOTENV_CONFIG_QUIET = "true";
