const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const archive = process.argv[2];
assert.ok(archive, 'Usage: node scripts/verify-release.cjs <app.asar>');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(packaged.version, manifest.version);
assert.equal(packaged.dependencies['@sly-rentals/core'], manifest.dependencies['@sly-rentals/core']);
for (const root of ['electron', 'ui', 'dist/src']) {
  for (const relative of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, relative);
    if (!fs.statSync(file).isFile()) continue;
    assert.ok(asar.extractFile(archive, file.replaceAll('\\', '/')).equals(fs.readFileSync(file)), `Packaged file differs: ${file}`);
  }
}
console.log(`Verified packaged version ${manifest.version} and all Electron, UI, and domain files.`);
