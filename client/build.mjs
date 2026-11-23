// The client is one script tag, so the source tree is bundled into a single
// app.js. Run through `make client`; the server keeps serving the built file.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The working directory is taken from this file, so the build works from any
// directory and the module markers in the bundle stay relative.
const here = dirname(fileURLToPath(import.meta.url));

const options = {
  absWorkingDir: here,
  entryPoints: ['src/boot.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  outfile: '../static/app.js',
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
} else {
  await build(options);
}
