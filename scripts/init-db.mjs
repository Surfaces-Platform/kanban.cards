import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStateStore } = require("../state-store");

const store = createStateStore();
const state = await store.read();
await store.write(state);

process.stdout.write(`Initialized ${store.kind} workspace at ${store.path}\n`);
