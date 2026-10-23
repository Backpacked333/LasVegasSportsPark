import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from '@sportspark/contracts';

const version = process.env['APP_VERSION'] ?? '0.1.0';
const document = buildOpenApiDocument(version);
const target = path.resolve(__dirname, '..', '..', '..', 'docs', 'api', 'openapi.json');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.warn(`wrote ${target} (${Object.keys(document.paths ?? {}).length} paths)`);
