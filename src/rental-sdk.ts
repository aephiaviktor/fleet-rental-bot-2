import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const MAINNET_SAGE_PROGRAM = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';

export function rentalSdk(): typeof import('@sly-rentals/core') {
  const sdk = require('@sly-rentals/core') as typeof import('@sly-rentals/core');
  sdk.setSdkConfig({ programs: 'mainnet' });
  const sage = sdk.getAddresses().sage;
  if (sage !== MAINNET_SAGE_PROGRAM) {
    throw new Error('Rental SDK mainnet SAGE mismatch: ' + sage);
  }
  return sdk;
}
