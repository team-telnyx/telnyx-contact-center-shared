// Keep the actual 1.9 runtime floor (Puppeteer 25), without Babel 8's extra bump.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Node.js >=22.12.0 is required. Use Node.js 24 LTS or a supported 22.x release.');
  process.exit(1);
}
