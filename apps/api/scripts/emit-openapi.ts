import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emitOpenApiDocument } from '../src/openapi-document';

const document = emitOpenApiDocument();
const target = path.resolve(__dirname, '..', '..', '..', 'docs', 'api', 'openapi.json');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.warn(`wrote ${target} (${Object.keys(document.paths ?? {}).length} paths)`);
