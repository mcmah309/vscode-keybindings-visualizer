import { context, build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('artifacts', { recursive: true });
const jobs = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['src/webview/app.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
];
for (const job of jobs) {
  // jsonc-parser's UMD entry passes require through a factory, which esbuild
  // cannot statically bundle. Prefer its ESM entry for a self-contained VSIX.
  const options = { ...job, bundle: true, mainFields: ['module', 'main'], sourcemap: true, target: 'es2022', logLevel: 'info' };
  if (process.argv.includes('--watch')) await (await context(options)).watch();
  else await build(options);
}
