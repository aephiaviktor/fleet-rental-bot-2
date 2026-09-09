const path = require('node:path');

const VALID_INSTANCES = new Set(['MUD', 'ONI', 'UST']);

function parseInstance(argv = process.argv) {
  const args = Array.from(argv).slice(1).map((value) => String(value));
  let value = '';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--instance') value = args[index + 1] || '';
    else if (args[index].startsWith('--instance=')) value = args[index].slice('--instance='.length);
  }
  const normalized = value.trim().toUpperCase() === 'USTUR' ? 'UST' : value.trim().toUpperCase();
  if (!normalized) throw new Error('Fleet Rental Bot 2 instance is required. Use --instance MUD, ONI, or UST.');
  if (!VALID_INSTANCES.has(normalized)) throw new Error('Fleet Rental Bot 2 instance must be MUD, ONI, or UST.');
  return normalized;
}

function configureInstance(app, argv = process.argv) {
  const instance = parseInstance(argv);
  const title = `Fleet Rental Bot 2 - ${instance}`;
  const userData = path.join(app.getPath('appData'), 'fleet-rental-bot-2', 'instances', instance);
  const iconName = instance === 'UST' ? 'fleet-rental-bot-ustur.ico' : `fleet-rental-bot-${instance.toLowerCase()}.ico`;
  const icon = path.join(app.getAppPath(), 'assets', iconName);
  app.setPath('userData', userData);
  app.setPath('sessionData', path.join(userData, 'session'));
  app.setName(title);
  app.setAppUserModelId(`com.aephia.fleet-rental-bot-2.${instance.toLowerCase()}`);
  return { instance, title, userData, icon };
}

module.exports = { configureInstance, parseInstance };
