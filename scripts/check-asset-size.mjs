/**
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Checks the deployable output against the limits of Cloudflare Pages /
 * Workers static assets, so an oversized build fails before `wrangler` uploads
 * anything.
 *
 * Cloudflare limits (per deployment):
 * - 25 MiB per file
 * - 20,000 files
 * There is no total-size limit for static assets: the wasm files are uploaded
 * as regular assets, they are not part of a Worker script bundle (which does
 * have a ~10 MiB compressed limit).
 *
 * Usage: node scripts/check-asset-size.mjs [dir]
 *
 * Env:
 * - MAX_FILE_BYTES: per-file limit (default 25 MiB)
 * - MAX_TOTAL_BYTES: warn above this total (default 20 MiB)
 */
import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const root = process.argv[2] ?? 'build';
const MiB = 1024 * 1024;

const maxFileBytes = Number(process.env.MAX_FILE_BYTES ?? 25 * MiB);
const maxTotalBytes = Number(process.env.MAX_TOTAL_BYTES ?? 20 * MiB);
const maxFiles = 20000;

function walk(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push({ path, size: statSync(path).size });
    }
  }

  return files;
}

const formatSize = (bytes) => `${(bytes / MiB).toFixed(2)} MiB`;

let files;
try {
  files = walk(root);
} catch {
  console.error(`Cannot read ${root}. Run the build first.`);
  process.exit(1);
}

const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
const wasmFiles = files.filter((file) => file.path.endsWith('.wasm'));
const wasmBytes = wasmFiles.reduce((sum, file) => sum + file.size, 0);
const oversized = files
  .filter((file) => file.size > maxFileBytes)
  .sort((a, b) => b.size - a.size);
const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);

console.log(
  `${files.length} files, ${formatSize(totalBytes)} total ` +
    `(${wasmFiles.length} wasm files, ${formatSize(wasmBytes)})`,
);
console.log('Largest files:');
for (const file of largest) {
  const name = relative(root, file.path).split(sep).join('/');
  console.log(`  ${formatSize(file.size).padStart(10)}  ${name}`);
}

let failed = false;

if (oversized.length) {
  failed = true;
  console.error(`\nFiles larger than ${formatSize(maxFileBytes)}:`);
  for (const file of oversized) {
    console.error(`  ${formatSize(file.size)}  ${relative(root, file.path)}`);
  }
  console.error(
    'Cloudflare rejects these. Either keep them out of the deploy or split\n' +
      'them into smaller assets.',
  );
}

if (files.length > maxFiles) {
  failed = true;
  console.error(
    `\n${files.length} files exceeds Cloudflare's limit of ${maxFiles}.`,
  );
}

if (totalBytes > maxTotalBytes && !failed) {
  // Not a Cloudflare limit: static assets have no total-size cap. The wasm
  // payload is fetched per codec worker, so it is not held in memory at once.
  console.warn(
    `\nNote: the deploy is ${formatSize(totalBytes)}, above the ` +
      `${formatSize(maxTotalBytes)} threshold. Static assets have no total ` +
      'limit, but keep codecs lazy: load one wasm module per worker, ' +
      'sequentially, so the browser does not hold every module in memory.',
  );
}

if (failed) process.exit(1);

console.log('\nDeploy size is within Cloudflare limits.');
