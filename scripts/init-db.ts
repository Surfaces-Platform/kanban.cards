import { createStateStore } from "../src/state-store";

async function main(): Promise<void> {
  const store = createStateStore();
  await store.read();

  process.stdout.write(`Initialized V2 ${store.kind} workspace at ${store.path}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
