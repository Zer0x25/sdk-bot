import { readFile, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';

const target = new URL('../generated.d.ts', import.meta.url);
const ast = await openapiTS(new URL('../openapi.json', import.meta.url), {
  alphabetize: true,
  // Defaults document server behavior; they do not make optional wire fields required.
  defaultNonNullable: false,
});
const content = '// Generated from openapi.json + schema.json. Run npm run contracts:generate.\n'
  + astToString(ast);
if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8');
  if (existing !== content) {
    throw new Error('Contract types drifted. Run npm run contracts:generate and commit generated.d.ts.');
  }
} else {
  await writeFile(target, content);
}
