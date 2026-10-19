#!/usr/bin/env node
// Synthetic VM-only integration fixture. It never contacts a deployed service.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [mode, directory, evidence] = process.argv.slice(2);
const configPath = path.join(directory || '.', 'private-config.json');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

async function main() {
  assert.ok(['server', 'web'].includes(mode), 'Use server or web mode');
  assert.ok(directory && evidence, 'Task-local runtime directory and evidence directory required');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  if (mode === 'web') {
    const c = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const { chromium } = require('@playwright/test');
    const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.shared.kanban.test 127.0.0.1, MAP shared.kanban.test 127.0.0.1'] });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: c.cookie.name, value: c.cookie.value, url: c.workspaceUrl, secure: true }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(c.workspaceUrl);
      await page.locator('#project-select').selectOption(c.projectId);
      await page.locator('button.board-card').filter({ hasText: c.expectedTitle }).click();
      const title = page.getByLabel('Title', { exact: true });
      assert.equal(await title.inputValue(), c.expectedTitle);
      const read = async () => {
        const response = await fetch(`${c.loopbackUrl}/api/projects/${c.projectId}`, { headers: { Host: new URL(c.workspaceUrl).host, 'X-Forwarded-Host': new URL(c.workspaceUrl).host, 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${c.token}` } });
        assert.equal(response.status, 200);
        return (await response.json()).project.cards.find(card => card.id === c.cardId);
      };
      const before = await read();
      if (c.writeTitle) {
        await title.fill(c.writeTitle);
        await title.press('Tab');
        await page.waitForTimeout(150);
        assert.equal((await read()).title, c.expectedTitle, 'Typing and blur must stay local');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        for (let attempt = 0; attempt < 50 && (await read()).title !== c.writeTitle; attempt++) await page.waitForTimeout(100);
        assert.equal((await read()).title, c.writeTitle);
        await page.reload();
        await page.locator('button.board-card').filter({ hasText: c.writeTitle }).click();
        assert.equal(await title.inputValue(), c.writeTitle);
      }
      const after = await read();
      assert.equal(after.body, before.body);
      assert.equal(after.columnId, before.columnId);
      assert.deepEqual(errors, []);
      const safePhase = String(c.phase).replace(/[^a-z0-9-]/gi, '-');
      await page.screenshot({ path: path.join(evidence, `${safePhase}.png`), fullPage: true });
      await fs.writeFile(path.join(evidence, `${safePhase}.json`), JSON.stringify({ scope: 'Actual production web UI against isolated backend', phase: c.phase, expectedTitle: c.expectedTitle, writeTitle: c.writeTitle, before, after, pageErrors: errors }, null, 2));
      await context.close();
    } finally { await browser.close(); }
    return;
  }

  const { createApp } = require('../dist/src/server.js');
  const { createFileAccessStore } = require('../dist/src/access-store.js');
  const { createRootSessionCookie, createTenantSessionCookie } = require('../dist/src/app-sessions.js');
  const { getPasskeyConfig, hashSecret } = require('../dist/src/passkey-auth.js');
  const secureServer = https.createServer({ key: await fs.readFile(path.join(directory, 'server.key')), cert: await fs.readFile(path.join(directory, 'server.crt')) });
  const tlsPort = await listen(secureServer);
  const rootHost = `shared.kanban.test:${tlsPort}`;
  const rootUrl = `https://${rootHost}`;
  const authHost = `auth.${rootHost}`;
  const secret = crypto.randomBytes(48).toString('base64url');
  const authConfig = getPasskeyConfig({ SESSION_SECRET: secret, KANBAN_CARDS_ROOT_HOST: rootHost, KANBAN_CARDS_AUTH_HOST: authHost });
  const accessStore = createFileAccessStore(path.join(directory, 'access.json'));
  const workspace = await accessStore.createWorkspace({ providerSubject: 'synthetic-shared-owner', email: 'synthetic@example.invalid', displayName: 'Synthetic Owner', slug: 'shared', name: 'Shared editing fixture' });
  const ownerId = workspace.ownerIds[0];
  const token = `kcn_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await accessStore.authTransaction(state => {
    state.nativeSessions.push({ id: 'synthetic-native-handoff', ownerId, credentialHash: hashSecret(token), rootOrigin: rootUrl, createdAt: now, expiresAt, revokedAt: null });
    state.authSessions.push({ id: 'synthetic-browser-handoff', ownerId, rootOrigin: rootUrl, createdAt: now, expiresAt, verifiedAt: now, revokedAt: null });
  });
  const app = createApp({ host: '127.0.0.1', rootHost, passkeyAuthConfig: authConfig, accessStore, requireDatabase: false, trustForwardedHost: true, dataPath: path.join(directory, 'legacy.json'), workspaceDirectory: path.join(directory, 'workspaces'), staticDir: process.cwd() });
  let traceTail = Promise.resolve();
  const trace = (request, response) => {
    if (!request.url?.startsWith('/api/')) return;
    response.once('finish', () => {
      const record = { method: request.method, path: request.url.split('?')[0], host: request.headers['x-forwarded-host'] || request.headers.host, status: response.statusCode, version: request.headers['x-kanban-version'], body: request.body };
      // Keep request writes serialized and guest-local. Shared-folder append can fail under concurrent I/O.
      traceTail = traceTail.then(() => fs.appendFile(path.join(directory, 'server-requests.jsonl'), JSON.stringify(record) + '\n'));
      traceTail.catch(error => { console.error('Request trace could not be saved:', error.message); });
    });
  };
  const serve = (request, response) => { trace(request, response); app(request, response); };
  secureServer.on('request', serve);
  const plainServer = http.createServer(serve);
  const httpPort = await listen(plainServer);
  const loopbackUrl = `http://127.0.0.1:${httpPort}`;
  const workspaceUrl = `https://shared.${rootHost}`;
  const api = async (route, body) => {
    const response = await fetch(`${loopbackUrl}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Host: new URL(workspaceUrl).host, 'X-Forwarded-Host': new URL(workspaceUrl).host, 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const { project } = await api('/projects', { name: 'Shared saved handoff', description: 'Synthetic VM-only fixture', columns: [{ id: 'next', name: 'Next' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] });
  const { card } = await api(`/projects/${project.id}/cards`, { title: 'Initial shared title', body: 'Preserve source\n\n  whitespace.  \n', columnId: 'next', nextActor: 'human', nextAction: 'Review shared data', priority: 'Medium', blockedReason: '' });
  const cookieText = await createTenantSessionCookie({ providerSubject: ownerId, email: 'synthetic@example.invalid', displayName: 'Synthetic Owner', sessionId: 'synthetic-browser-handoff', rootOrigin: rootUrl, workspaceId: workspace.id, tenantOrigin: workspaceUrl }, secret, true);
  const [cookieName, ...cookieValue] = cookieText.split(';')[0].split('=');
  const privateConfig = { loopbackUrl, rootUrl, authUrl: `https://${authHost}`, token, expiresAt, owner: { id: ownerId, displayName: 'Synthetic Owner', email: 'synthetic@example.invalid' }, workspaceUrl, projectId: project.id, cardId: card.id, cookie: { name: cookieName, value: cookieValue.join('=') }, expectedTitle: card.title, writeTitle: '', phase: 'initial' };
  await fs.writeFile(configPath, JSON.stringify(privateConfig, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(evidence, 'server-ready.json'), JSON.stringify({ scope: 'Synthetic isolated server; no deployed services', loopbackUrl, rootUrl, workspaceUrl, projectId: project.id, cardId: card.id, ownerId }, null, 2));
  console.log('Synthetic shared handoff backend ready on guest loopback. Runtime credentials remain guest-local.');
  const stop = () => { plainServer.close(); secureServer.close(); void traceTail.then(() => fs.copyFile(path.join(directory, 'server-requests.jsonl'), path.join(evidence, 'server-requests.jsonl'))); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
