#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'docs/shared-interactions');
const inputs = { features: resolve(directory, 'features.json'), scenarios: resolve(directory, 'scenarios.json') };
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.length > 0 && value.every(string);
const clients = ['macos', 'ios', 'web'];
const priorities = ['High', 'Medium', 'Low'];
const sourceCache = new Map();

for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  if (!Object.hasOwn(inputs, key) || !process.argv[index + 1]) {
    console.error('Usage: node scripts/check-shared-interactions.mjs [--features FILE] [--scenarios FILE]');
    process.exit(1);
  }
  inputs[key] = resolve(process.argv[index + 1]);
}

function readJson(path) {
  try {
    const result = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(result)) throw new Error('top-level JSON object required');
    return result;
  } catch (error) { errors.push(`${relative(root, path)}: ${error.message}`); return {}; }
}
function safePath(path) {
  return string(path) && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.includes('\\');
}
function envelope(value, label) {
  check(object(value) && value.schemaVersion === 1, `${label}: schemaVersion must be 1`);
  check(object(value.basis) && /^[a-f0-9]{40}$/.test(value.basis.commit ?? ''), `${label}: full baseline commit required`);
  check(string(value.basis?.interpretation), `${label}: describe source/scenario evidence limits`);
  check(value.runtimeAcceptance === 'pending', `${label}: specification inventory must not claim runtime acceptance`);
}
function source(reference, commit, featureId) {
  const match = typeof reference === 'string' && reference.match(/^(.+):(\d+)$/);
  if (!match || !safePath(match[1]) || Number(match[2]) < 1) {
    errors.push(`${featureId}: invalid source reference ${JSON.stringify(reference)}`); return;
  }
  const [path, line] = [match[1], Number(match[2])];
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) return;
  const key = `${commit}:${path}`;
  if (!sourceCache.has(key)) {
    try { sourceCache.set(key, execFileSync('git', ['cat-file', 'blob', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 })); }
    catch { sourceCache.set(key, null); }
  }
  const content = sourceCache.get(key);
  check(content !== null && content !== undefined, `${featureId}: source missing at baseline: ${reference}`);
  if (typeof content === 'string') check(line <= content.split('\n').length, `${featureId}: source line outside file: ${reference}`);
}
function unique(values, label) {
  check(values.length === new Set(values).size, `${label}: duplicate identifier`);
}
function localLinks(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { errors.push(`Missing document: ${relative(root, path)}`); return ''; }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1];
    if (/^[a-z]+:/i.test(raw) || raw.startsWith('#')) continue;
    const target = raw.split('#')[0].replace(/:\d+$/, '');
    const absolute = resolve(dirname(path), target);
    const fromRoot = relative(root, absolute);
    check(fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot), `${relative(root, path)}: link leaves repository: ${raw}`);
    check(existsSync(absolute), `${relative(root, path)}: missing local link ${raw}`);
  }
  return text;
}

const registry = readJson(inputs.features);
const acceptance = readJson(inputs.scenarios);
envelope(registry, 'features');
envelope(acceptance, 'scenarios');
check(registry.basis?.commit === acceptance.basis?.commit, 'features and scenarios must share a baseline commit');
if (/^[a-f0-9]{40}$/.test(registry.basis?.commit ?? '')) {
  try { execFileSync('git', ['cat-file', '-e', `${registry.basis.commit}^{commit}`], { cwd: root, stdio: 'ignore' }); }
  catch { errors.push('Declared baseline commit is unavailable locally; use a checkout containing that commit. CI must fetch history.'); }
}
const features = Array.isArray(registry.features) ? registry.features : [];
const scenarios = Array.isArray(acceptance.scenarios) ? acceptance.scenarios : [];
check(features.length > 0, 'features: nonempty inventory required');
check(scenarios.length > 0, 'scenarios: nonempty acceptance scenarios required');
check(object(acceptance.fixture), 'scenarios: shared synthetic fixture required');
const featureIds = features.map(feature => feature?.id);
const scenarioIds = scenarios.map(scenario => scenario?.id);
unique(featureIds, 'features');
unique(scenarioIds, 'scenarios');
const knownFeatures = new Set(featureIds);
const coveredFeatures = new Set();
for (const feature of features) {
  if (!object(feature)) { errors.push('features: each entry must be an object'); continue; }
  const label = feature.id ?? '<missing feature id>';
  check(/^feature-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.id ?? ''), `${label}: invalid feature ID`);
  check(string(feature.name) && string(feature.target), `${label}: name and target required`);
  check(priorities.includes(feature.priority), `${label}: use High, Medium, or Low priority`);
  check(object(feature.clients) && Object.keys(feature.clients).sort().join(',') === [...clients].sort().join(','), `${label}: exactly macos, ios, and web required`);
  for (const client of clients) {
    const cell = feature.clients?.[client];
    check(object(cell) && ['aligned', 'partial', 'missing'].includes(cell.status), `${label}/${client}: source comparison status required`);
    check(object(cell) && Object.keys(cell).sort().join(',') === 'detail,sources,status', `${label}/${client}: only source-comparison status, detail, and sources allowed; runtime evidence belongs in separate receipts`);
    check(string(cell?.detail), `${label}/${client}: current behavior detail required`);
    check(strings(cell?.sources), `${label}/${client}: baseline source references required`);
    if (Array.isArray(cell?.sources)) for (const reference of cell.sources) source(reference, registry.basis?.commit, label);
  }
}
for (const scenario of scenarios) {
  if (!object(scenario)) { errors.push('scenarios: each entry must be an object'); continue; }
  const label = scenario.id ?? '<missing scenario id>';
  check(/^SI-\d{3}$/.test(scenario.id ?? ''), `${label}: invalid scenario ID`);
  check(string(scenario.title), `${label}: title required`);
  check(priorities.includes(scenario.priority), `${label}: use High, Medium, or Low priority`);
  check(Array.isArray(scenario.platforms) && scenario.platforms.length === 3 && [...scenario.platforms].sort().join(',') === [...clients].sort().join(','), `${label}: must cover all three clients exactly once`);
  check(strings(scenario.capabilityIds), `${label}: capability IDs required`);
  if (Array.isArray(scenario.capabilityIds)) {
    unique(scenario.capabilityIds, label);
    for (const id of scenario.capabilityIds) {
      check(knownFeatures.has(id), `${label}: unknown capability ${id}`);
      coveredFeatures.add(id);
    }
  }
  for (const field of ['given', 'when', 'then']) check(strings(scenario[field]), `${label}: nonempty ${field} assertions required`);
}
for (const id of featureIds) check(coveredFeatures.has(id), `${id}: no shared acceptance scenario`);
const featureDocument = localLinks(resolve(directory, 'features.md'));
const scenarioDocument = localLinks(resolve(directory, 'acceptance.md'));
localLinks(resolve(directory, 'README.md'));
for (const id of featureIds) check(featureDocument.includes(id), `features.md: missing ${id}`);
for (const id of scenarioIds) check(scenarioDocument.includes(id), `acceptance.md: missing ${id}`);
for (const path of ['README.md', 'DESIGN.md', 'UI_CONTRACT.md']) {
  check(readFileSync(resolve(root, path), 'utf8').includes('docs/shared-interactions/README.md'), `${path}: shared-target authority pointer required`);
}
const packageJson = readJson(resolve(root, 'package.json'));
check(packageJson.scripts?.['check:shared-interactions'] === 'node scripts/check-shared-interactions.mjs', 'package.json: runnable shared-specification check required');
check(packageJson.scripts?.check?.includes('npm run check:shared-interactions'), 'package.json: shared specification check must run in existing CI check');
if (errors.length) {
  console.error(`Shared interaction specification failed (${errors.length}):\n${errors.map(error => `- ${error}`).join('\n')}`);
  process.exit(1);
}
console.log(`Shared interaction specification valid: ${features.length} capabilities, ${scenarios.length} scenarios, ${sourceCache.size} baseline source files. Runtime acceptance remains pending for macos, ios, and web.`);
