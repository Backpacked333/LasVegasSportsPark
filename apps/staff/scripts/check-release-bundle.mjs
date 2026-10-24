// Release-bundle check (§5.2, §4.14): the development sign-in must not ship in a production build.
// Run after `vite build`; fails when any emitted file contains a development-only marker.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'dist');
const MARKERS = ['Development sign-in', '/dev/tokens'];

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const emitted = files(dir).filter((f) => /\.(js|mjs|html|css)$/.test(f));
if (emitted.length === 0) {
  console.error(`No bundle files found in ${dir}`);
  process.exit(1);
}
const offending = emitted.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return MARKERS.filter((m) => text.includes(m)).map((m) => `${path.relative(dir, file)}: "${m}"`);
});
if (offending.length > 0) {
  console.error(`Development-only code found in the release bundle:\n  ${offending.join('\n  ')}`);
  process.exit(1);
}
console.log(`Release bundle clean: ${emitted.length} files checked, no development sign-in.`);
