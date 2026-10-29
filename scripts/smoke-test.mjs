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
 * End-to-end smoke test of the built site: serves `build/`, opens it in
 * headless Chromium, drops a PNG on the app and fails if the page logs an
 * exception or a console error (which is how broken wasm URLs show up).
 *
 * Usage: node scripts/smoke-test.mjs [buildDir]
 * Requires a Chromium/Chrome binary; set CHROME_PATH if it isn't found.
 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { extname, join, normalize } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { existsSync } from 'fs';

const ROOT = new URL(`../${process.argv[2] ?? 'build'}/`, import.meta.url)
  .pathname;
const CHROME =
  process.env.CHROME_PATH ??
  [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync);

if (!CHROME) {
  console.log('No Chromium found, set CHROME_PATH to run the smoke test.');
  process.exit(0);
}

const port = 8000 + Math.floor(Math.random() * 900);
const debugPort = port + 1000;
const profileDir = `/tmp/squoosh-smoke-${randomUUID()}`;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
  if (url.pathname.endsWith('/')) path = join(path, 'index.html');

  try {
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type':
        contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      // The wasm codecs need SharedArrayBuffer.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(port, resolve));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: true },
);

function stop() {
  try {
    process.kill(-chrome.pid, 'SIGKILL');
  } catch {}
  server.close();
}

async function getPageTarget() {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/list`,
      );
      const page = (await response.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(200);
  }
  throw Error('Chromium did not start');
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let messageId = 0;
const pending = new Map();
const problems = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);

  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error
      ? reject(Error(JSON.stringify(message.error)))
      : resolve(message.result);
    return;
  }

  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    problems.push(`exception: ${details.exception?.description ?? details.text}`);
  }

  if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(' ');
    if (message.params.type === 'error') problems.push(`console: ${text}`);
  }

  // Only report failed requests for our own origin; third-party scripts
  // (e.g. Google Analytics) are allowed to fail.
  if (message.method === 'Log.entryAdded') {
    const entry = message.params.entry;
    const isLocal = !entry.url || entry.url.startsWith(`http://127.0.0.1:`);
    if (entry.level === 'error' && isLocal) {
      problems.push(`log: ${entry.text} ${entry.url ?? ''}`);
    }
  }
});

function send(method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

// Wait for the app to boot.
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if (
      await evaluate(`!!customElements.get('file-drop') &&
        !!document.querySelector('file-drop')`)
    ) {
      break;
    }
  } catch {}
  await sleep(250);
}

const image = (
  await readFile(new URL('../codecs/example_palette.png', import.meta.url))
).toString('base64');

const result = await evaluate(`(async () => {
  const blob = await (await fetch('data:image/png;base64,${image}')).blob();
  const drop = document.querySelector('file-drop');
  if (!drop) return { error: 'no file-drop element' };

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File([blob], 'example.png', { type: 'image/png' }));
  drop.dispatchEvent(
    new DragEvent('drop', {
      dataTransfer,
      bubbles: true,
      cancelable: true,
    }),
  );

  // Give the encoder worker time to load its wasm and encode.
  await new Promise((resolve) => setTimeout(resolve, 8000));

  return {
    outputLinks: document.querySelectorAll('a[href^="blob:"]').length,
    showsSize: /\\d+(\\.\\d+)?\\s?(kB|KB|MB)/.test(document.body.innerText),
  };
})()`);

stop();

console.log('smoke test:', JSON.stringify(result));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of [...new Set(problems)].slice(0, 10)) {
    console.error(' -', problem.slice(0, 500));
  }
  process.exit(1);
}
console.log('no console errors or exceptions');
