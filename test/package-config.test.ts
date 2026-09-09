import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('packaging includes runtime files and excludes source and tests', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
    build: { asar: boolean; files: string[] };
  };
  assert.match(pkg.dependencies.ws, /^\^8\./, 'Solana WebSocket peer must be packaged as a direct runtime dependency');
  assert.equal(pkg.build.asar, true);
  assert.deepEqual(pkg.build.files, ['electron/**/*', 'assets/fleet-rental-bot-*.ico', 'ui/**/*', 'dist/src/**/*', 'package.json']);
  assert.equal(pkg.build.files.some((path) => path.startsWith('test/')), false);
  assert.equal(pkg.build.files.some((path) => path.startsWith('src/')), false);
});

test('Windows packaging produces a branded versioned portable artifact', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
    build: { win: { target: string[]; icon: string; artifactName: string } };
  };
  assert.deepEqual(pkg.build.win.target, ['portable']);
  assert.equal(pkg.build.win.icon, 'assets/fleet-rental-bot-2.ico');
  assert.match(pkg.build.win.artifactName, /\$\{version\}/);
});
