// The client is one script tag, so the source tree is bundled into a single
// app.js. Run through `make client`; the server keeps serving the built file.
import { build } from 'esbuild';

const options = {
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
