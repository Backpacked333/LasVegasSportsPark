// Release-bundle smoke check (§6.2: a successful export is not native acceptance). Verifies that
// `expo export` produced a bundle and that the development sign-in and the development payment
// method (fake provider tokens) are not in it (§5.2). Bundles may be Hermes bytecode, so files are
// searched as bytes.
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'dist');
const MARKERS = ['Development sign-in', '/dev/tokens', 'Development payment method', 'pm_fake_'];

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const bundles = files(path.join(dir, '_expo')).filter((f) => /\.(hbc|js)$/.test(f));
if (bundles.length === 0) {
  console.error(`No bundle found under ${dir}/_expo`);
  process.exit(1);
}
const offending = bundles.flatMap((file) => {
  const bytes = readFileSync(file);
  return MARKERS.filter((m) => bytes.includes(Buffer.from(m, 'utf8'))).map(
    (m) => `${path.relative(dir, file)}: "${m}"`,
  );
});
if (offending.length > 0) {
  console.error(`Development-only code found in the release bundle:\n  ${offending.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Release bundle clean: ${bundles.length} bundle(s) checked, no development sign-in or payment method.`,
);
