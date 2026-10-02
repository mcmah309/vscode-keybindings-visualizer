import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

await import('./build.mjs');
await mkdir('.cache', { recursive: true });
await build({ entryPoints: ['test/integration.ts'], outfile: '.cache/integration.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'playwright-core'], target: 'es2022' });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const userData = await mkdtemp(resolve('.cache/vscode-user-data-'));
const fixture = resolve(userData, 'User', 'profiles', 'integration-fixture');
try {
  await mkdir(resolve(userData, 'User', 'globalStorage'), { recursive: true });
  await mkdir(fixture, { recursive: true });
  // VS Code deletes unregistered profile folders during background cleanup.
  // Register the fixture before startup so integration tests exercise a real profile.
  await writeFile(resolve(userData, 'User', 'globalStorage', 'storage.json'), JSON.stringify({ userDataProfiles: [{ name: 'Integration profile', location: 'integration-fixture' }] }));
  await writeFile(resolve(fixture, 'keybindings.json'), '[]');
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    extensionDevelopmentPath: resolve('.'),
    extensionTestsPath: resolve('.cache/integration.cjs'),
    extensionTestsEnv: { VKV_CDP_PORT: String(port), VKV_ARTIFACTS: resolve('artifacts') },
    launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
  });
} finally {
  await rm(userData, { recursive: true, force: true });
}
