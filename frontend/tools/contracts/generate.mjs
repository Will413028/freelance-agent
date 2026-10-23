import openapiTS, { astToString } from 'openapi-typescript';
import { readFile, writeFile } from 'node:fs/promises';

const schema = new URL('../../../contracts/openapi.json', import.meta.url);
const output = new URL('../../../contracts/api.d.ts', import.meta.url);
const generated = '/** Generated from backend/src/freelance/bootstrap/contracts.py; do not edit. */\n' + astToString(await openapiTS(schema));
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8').catch(() => '') !== generated) {
    throw new Error('Generated types are stale; run pnpm contracts:generate.');
  }
} else {
  await writeFile(output, generated);
}
