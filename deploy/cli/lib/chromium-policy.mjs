import { readFileSync } from 'node:fs';

// Every cloud provider ships the same reviewed policy as the standard image.
export const chromiumSeccomp = JSON.stringify(JSON.parse(readFileSync(
  new URL('../../../docker/production/chromium-seccomp.json', import.meta.url), 'utf8',
)));
