// Shared diagnostic logger for ACD Core modules. Best-effort bridges must
// never be silent — every swallowed failure is at least a warn here.

import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

export const acdLogger = createDiagnosticLogger("acd");
