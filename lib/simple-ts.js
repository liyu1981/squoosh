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
import { spawn } from 'child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { promises as fsp, existsSync, statSync } from 'fs';
import { sync as whichSync } from 'which';

const tscPath = whichSync('tsc');

const extRe = /\.tsx?$/;
const resolveExtensions = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * tsconfig files are JSON with comments and trailing commas.
 * @param {string} text
 */
function parseJsonConfig(text) {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (char === '\\') {
        result += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return JSON.parse(result.replace(/,(?=\s*[}\]])/g, ''));
}

/** @param {string} startPath */
function findConfigFile(startPath) {
  let dir = isAbsolute(startPath)
    ? startPath
    : resolve(process.cwd(), startPath);

  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** @param {string} configPath */
async function readConfigChain(configPath) {
  /** @type {{ dir: string, json: any }[]} */
  const chain = [];
  let current = configPath;

  while (current) {
    const json = parseJsonConfig(await fsp.readFile(current, 'utf8'));
    chain.unshift({ dir: dirname(current), json });

    if (!json.extends) break;

    let next = resolve(dirname(current), json.extends);
    if (!existsSync(next)) next += '.json';
    current = existsSync(next) ? next : undefined;
  }

  return chain;
}

/**
 * Reads the merged compiler options of a tsconfig file, along with the
 * `paths` mappings (resolved against the directory of the config that
 * declared them).
 * @param {string} mainPath
 */
async function loadConfig(mainPath) {
  const configPath = findConfigFile(mainPath);
  if (!configPath) throw Error('tsconfig not found');

  const chain = await readConfigChain(configPath);
  /** @type {Record<string, any>} */
  const options = {};
  /** @type {{ baseDir: string, paths: Record<string, string[]> }[]} */
  const pathMappings = [];

  for (const { dir, json } of chain) {
    const compilerOptions = json.compilerOptions ?? {};

    for (const [key, value] of Object.entries(compilerOptions)) {
      if (key === 'paths' || key === 'baseUrl') continue;
      // Path-like options are relative to the config file that declares them.
      options[key] =
        (key === 'outDir' || key === 'rootDir') && typeof value === 'string'
          ? resolve(dir, value)
          : value;
    }

    if (compilerOptions.paths) {
      pathMappings.push({
        baseDir: compilerOptions.baseUrl
          ? resolve(dir, compilerOptions.baseUrl)
          : dir,
        paths: compilerOptions.paths,
      });
    }
  }

  return { options, pathMappings };
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a path to a file, trying the same extension-less lookup that
 * TypeScript does.
 * @param {string} basePath
 */
function resolveFile(basePath) {
  if (isFile(basePath)) return basePath;

  for (const ext of resolveExtensions) {
    if (isFile(basePath + ext)) return basePath + ext;
  }

  for (const ext of resolveExtensions) {
    const indexPath = join(basePath, `index${ext}`);
    if (isFile(indexPath)) return indexPath;
  }
}

/**
 * Resolves a module id against the `paths` mappings of the tsconfig.
 * @param {string} id
 * @param {{ baseDir: string, paths: Record<string, string[]> }[]} pathMappings
 */
function resolvePaths(id, pathMappings) {
  for (const { baseDir, paths } of pathMappings) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const starIndex = pattern.indexOf('*');
      let wildcard;

      if (starIndex === -1) {
        if (id !== pattern) continue;
        wildcard = '';
      } else {
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);
        if (
          !id.startsWith(prefix) ||
          !id.endsWith(suffix) ||
          id.length < prefix.length + suffix.length
        ) {
          continue;
        }
        wildcard = id.slice(prefix.length, id.length - suffix.length);
      }

      for (const target of targets) {
        const match = resolveFile(
          resolve(baseDir, target.replace('*', wildcard)),
        );
        if (match) return match;
      }
    }
  }
}

const isInNodeModules = (path) => /[\\/]node_modules[\\/]/.test(path);

/** @param {string} dir */
async function findJsFiles(dir) {
  /** @type {string[]} */
  const results = [];
  let entries;

  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findJsFiles(path)));
    } else if (entry.name.endsWith('.js')) {
      results.push(path);
    }
  }

  return results;
}

export default function simpleTS(mainPath, { noBuild, watch } = {}) {
  const config = loadConfig(mainPath);

  let tsBuildDone;

  async function watchBuiltFiles(rollupContext) {
    const { options } = await config;
    const matches = await findJsFiles(options.outDir);
    for (const match of matches) rollupContext.addWatchFile(match);
  }

  async function tsBuild(rollupContext) {
    if (tsBuildDone) {
      // Watch lists are cleared on each build, so we need to rewatch all the JS files.
      await watchBuiltFiles(rollupContext);
      return tsBuildDone;
    }

    if (noBuild) {
      return (tsBuildDone = Promise.resolve());
    }

    tsBuildDone = Promise.resolve().then(async () => {
      await new Promise((resolvePromise) => {
        const proc = spawn(tscPath, ['-b', mainPath], {
          stdio: 'inherit',
          // `tsc` is a shell script on Windows.
          shell: process.platform === 'win32',
        });

        proc.on('exit', (code) => {
          if (code !== 0) {
            throw Error('TypeScript build failed');
          }
          resolvePromise();
        });
      });

      await watchBuiltFiles(rollupContext);

      if (watch) {
        tsBuildDone.then(() => {
          spawn(tscPath, ['-b', '--watch', '--preserveWatchOutput'], {
            stdio: 'inherit',
          });
        });
      }
    });

    return tsBuildDone;
  }

  return {
    name: 'simple-ts',
    async resolveId(id, importer) {
      // Virtual modules and plugin-prefixed ids (css:, url:, …) are handled
      // by the other plugins.
      if (id.startsWith('\0') || id.includes(':')) return null;

      const { pathMappings } = await config;

      if (isAbsolute(id) || id.startsWith('./') || id.startsWith('../')) {
        if (!importer || importer.startsWith('\0')) return null;
        const resolved = resolveFile(resolve(dirname(importer), id));
        return resolved && !isInNodeModules(resolved) ? resolved : null;
      }

      // Anything else is either a tsconfig `paths` alias or a bare specifier
      // for node_modules, which `@rollup/plugin-node-resolve` handles.
      const fromPaths = resolvePaths(id, pathMappings);
      return fromPaths && !isInNodeModules(fromPaths) ? fromPaths : null;
    },
    async load(id) {
      if (!extRe.test(id)) return null;

      // TypeScript building is deferred until the first TS file load.
      // This allows prerequisites to happen first,
      // such as css.d.ts generation in css-plugin.
      await tsBuild(this);

      // Look for the JS equivalent in the tmp folder
      const { options } = await config;
      const newId = join(options.outDir, relative(process.cwd(), id)).replace(
        extRe,
        '.js',
      );

      return fsp.readFile(newId, { encoding: 'utf8' });
    },
  };
}
