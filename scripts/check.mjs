import process from 'node:process';

const requiredNodeMajor = 22;
const current = Number(process.versions.node.split('.')[0]);

if (Number.isNaN(current) || current < requiredNodeMajor) {
  console.error(`[check] Node ${requiredNodeMajor}+ required; found ${process.versions.node}`);
  process.exit(1);
}

console.log(`[check] Node version OK: ${process.versions.node}`);
