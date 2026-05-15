import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStateStore } = require("../state-store");
const { createAgentTokenStore } = require("../agent-token-store");

const store = createStateStore();
const tokenStore = createAgentTokenStore();
const state = await store.read();
await store.write(state);
await tokenStore.ensureReady();

process.stdout.write(`Initialized ${store.kind} workspace at ${store.path}\n`);
process.stdout.write(`Initialized ${tokenStore.kind} agent tokens at ${tokenStore.path}\n`);
