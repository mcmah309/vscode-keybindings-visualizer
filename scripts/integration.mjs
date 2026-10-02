import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

await import('./build.mjs');
await mkdir('.cache', { recursive: true });
await build({ entryPoints: ['test/integration.ts'], outfile: '.cache/integration.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'playwright-core'], target: 'es2022' });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
await runTests({
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve('.cache/integration.cjs'),
  extensionTestsEnv: { VKV_CDP_PORT: String(port), VKV_ARTIFACTS: resolve('artifacts') },
  launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--remote-debugging-port=${port}`],
});
