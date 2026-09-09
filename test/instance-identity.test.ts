import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { configureInstance, parseInstance } = require(join(process.cwd(), 'electron', 'instance.cjs'));

test('accepts only explicit Fleet Rental Bot 2 instance identities', () => {
  assert.equal(parseInstance(['app.exe', '--instance', 'MUD']), 'MUD');
  assert.equal(parseInstance(['app.exe', '--instance=oni']), 'ONI');
  assert.equal(parseInstance(['app.exe', '--instance', 'UST']), 'UST');
  assert.equal(parseInstance(['app.exe', '--instance=USTUR']), 'UST');
  assert.throws(() => parseInstance(['app.exe']), /instance is required/i);
  assert.throws(() => parseInstance(['app.exe', '--instance=OTHER']), /MUD, ONI, or UST/);
});

test('configures distinct app identity and storage before startup', () => {
  const paths = new Map([['appData', 'C:\\Users\\Viktor\\AppData\\Roaming']]);
  const names: string[] = [];
  const modelIds: string[] = [];
  const app = {
    getPath: (key: string) => paths.get(key),
    setPath: (key: string, value: string) => paths.set(key, value),
    setName: (value: string) => names.push(value),
    setAppUserModelId: (value: string) => modelIds.push(value),
    getAppPath: () => 'C:\\Apps\\fleet-rental-bot-2-ONI\\resources\\app.asar',
  };

  const result = configureInstance(app, ['app.exe', '--instance=ONI']);

  assert.equal(result.instance, 'ONI');
  assert.equal(result.title, 'Fleet Rental Bot 2 - ONI');
  assert.match(paths.get('userData')!, /fleet-rental-bot-2[\\/]instances[\\/]ONI$/);
  assert.match(paths.get('sessionData')!, /fleet-rental-bot-2[\\/]instances[\\/]ONI[\\/]session$/);
  assert.deepEqual(names, ['Fleet Rental Bot 2 - ONI']);
  assert.deepEqual(modelIds, ['com.aephia.fleet-rental-bot-2.oni']);
  assert.match(result.icon, /assets[\\/]fleet-rental-bot-oni\.ico$/);
});

test('selects the correct packaged icon for every instance', () => {
  const createApp = () => ({
    getPath: () => 'C:\\Users\\Viktor\\AppData\\Roaming',
    setPath: () => {}, setName: () => {}, setAppUserModelId: () => {},
    getAppPath: () => 'C:\\app\\resources\\app.asar',
  });
  assert.match(configureInstance(createApp(), ['app.exe', '--instance=MUD']).icon, /fleet-rental-bot-mud\.ico$/);
  assert.match(configureInstance(createApp(), ['app.exe', '--instance=ONI']).icon, /fleet-rental-bot-oni\.ico$/);
  assert.match(configureInstance(createApp(), ['app.exe', '--instance=UST']).icon, /fleet-rental-bot-ustur\.ico$/);
});
