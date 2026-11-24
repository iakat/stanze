// Keep the line counts in client/README.md true, and say when a module in
// src/ is not in the table yet.
//
//   node tools/overview.mjs --write   update the counts in place
//   node tools/overview.mjs --check   fail on a stale count or an unlisted file
//
// A table row for a module looks like:
//   | [src/name.ts](src/name.ts) | 123 | one line about it |
// The description is never touched: a new module needs a line written by hand.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const readmePath = join(root, 'README.md');
const srcDir = join(root, 'src');

const row = /^(\| \[src\/([^\]/]+)\]\(src\/[^)]+\) \| )(\d+)( \|.*)$/;

const countLines = (path) => {
  const text = readFileSync(path, 'utf8');
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const modules = new Map(
  walk(srcDir).map((path) => [path.slice(srcDir.length + 1), countLines(path)]),
);

const lines = readFileSync(readmePath, 'utf8').split('\n');
const modes = process.argv.filter((a) => a === '--write' || a === '--check');
if (modes.length !== 1) {
  console.error('usage: overview.mjs --write | --check');
  process.exit(2);
}

const listed = new Map();
let stale = 0;

for (let i = 0; i < lines.length; i += 1) {
  const match = row.exec(lines[i]);
  if (!match) continue;
  const [, head, name, shown, tail] = match;
  const current = modules.get(name);
  if (current === undefined) {
    console.error(`readme row without a file: src/${name}`);
    stale += 1;
    continue;
  }
  listed.set(name, i);
  if (Number(shown) !== current) {
    stale += 1;
    if (modes[0] === '--write') {
      lines[i] = `${head}${current}${tail}`;
    } else {
      console.error(`stale count: src/${name} is ${current}, readme says ${shown}`);
    }
  }
}

const missing = [...modules.keys()].filter((name) => !listed.has(name)).sort();
for (const name of missing) {
  console.error(`not in the readme: src/${name} (${modules.get(name)} lines)`);
}

const failed = stale > 0 || missing.length > 0;
if (modes[0] === '--write') {
  writeFileSync(readmePath, lines.join('\n'));
  console.log(`counts written${stale ? `, ${stale} updated` : ', already current'}`);
}

if (failed && missing.length) {
  console.error('write a line for each module above, then run it again');
}
if (failed) process.exit(1);
console.log(`overview ok: ${modules.size} modules`);
