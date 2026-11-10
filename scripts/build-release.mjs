#!/usr/bin/env node
/**
 * Build an obfuscated release/ folder for Chrome Web Store upload.
 * Source in repo stays readable; ship only release/.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'release');

const OBFUSCATE = [
  'page/vest-bracket.js',
  'bridge.js',
  'sw.js',
  'popup.js',
  'license/validator.js',
];

const COPY_AS_IS = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'license/config.js',
  'legal/LICENSE',
  'EULA.md',
];

const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) rimraf(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('Cleaning release/…');
rimraf(outDir);
fs.mkdirSync(outDir, { recursive: true });

for (const rel of COPY_AS_IS) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.log('Copying icons/…');
copyDir(path.join(root, 'icons'), path.join(outDir, 'icons'));

for (const rel of OBFUSCATE) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    console.warn('Skip missing', rel);
    continue;
  }
  const code = fs.readFileSync(src, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result.getObfuscatedCode(), 'utf8');
  console.log('Obfuscated', rel);
}

const manifestPath = path.join(outDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.background) manifest.background = { service_worker: 'sw.js' };
manifest.background.service_worker = 'sw.js';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('\nDone → load unpacked from:', outDir);
console.log('Do not publish source; upload release/ to Chrome Web Store only.');
