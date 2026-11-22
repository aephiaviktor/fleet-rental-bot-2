const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ electronPlatformName, targets }) => {
  if (electronPlatformName !== 'win32' || !targets.some(target => target.name === 'portable')) return;

  const builder = path.dirname(require.resolve('app-builder-lib/package.json'));
  const template = path.join(builder, 'templates', 'nsis', 'portable.nsi');
  const source = await fs.readFile(template, 'utf8');
  const installPath = '  StrCpy $INSTDIR "$PLUGINSDIR\\app"';
  const initializedPath = `  InitPluginsDir\n${installPath}`;
  if (source.includes(initializedPath)) return;
  if (source.split(installPath).length !== 2) throw new Error('The electron-builder portable extraction template changed.');

  // The portable launcher is silent and NSIS skips .onGUIInit in silent mode.
  // Initialize the per-launch directory before the section first reads it.
  await fs.writeFile(template, source.replace(installPath, initializedPath), 'utf8');
};
