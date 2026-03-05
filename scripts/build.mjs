import { cp, mkdir, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'xpose');

async function ensureRequiredFiles() {
  const required = ['manifest.json', 'src/background.js', 'src/options.html', 'src/options.js', 'src/options.css'];
  for (const file of required) {
    const absolute = path.join(root, file);
    await access(absolute);
  }
}

async function validateManifest() {
  const raw = await readFile(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);

  if (manifest.manifest_version !== 3) {
    throw new Error('manifest_version must be 3');
  }

  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('tabs')) {
    throw new Error('permissions must include tabs');
  }

  if (!manifest.background?.service_worker) {
    throw new Error('background.service_worker is required');
  }
}

async function build() {
  console.log('[build] validating project files');
  await ensureRequiredFiles();
  await validateManifest();

  console.log('[build] creating dist folder');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log('[build] copying extension files');
  await cp(path.join(root, 'manifest.json'), path.join(outDir, 'manifest.json'));
  await cp(path.join(root, 'src'), path.join(outDir, 'src'), { recursive: true });

  console.log(`[build] extension build ready at ${outDir}`);
}

build().catch((error) => {
  console.error('[build] failed', error);
  process.exitCode = 1;
});
