import { createAgentTokenStore } from "../src/agent-token-store";
import { createEventStore } from "../src/event-store";
import { createStateStore } from "../src/state-store";

async function main(): Promise<void> {
  const store = createStateStore();
  const tokenStore = createAgentTokenStore();
  const eventStore = createEventStore();
  const state = await store.read();
  await store.write(state);
  await tokenStore.ensureReady();
  await eventStore.ensureReady();

  process.stdout.write(`Initialized ${store.kind} workspace at ${store.path}\n`);
  process.stdout.write(`Initialized ${tokenStore.kind} agent tokens at ${tokenStore.path}\n`);
  process.stdout.write(`Initialized ${eventStore.kind} events at ${eventStore.path}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
