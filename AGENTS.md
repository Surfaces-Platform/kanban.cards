# Agent instructions

## Disposable browser VM default

When browser work needs a VM for isolation, background execution, or a consistent environment, use the local VM manager at `/Users/mike/Codex/local-vm-manager`. Read and follow the [local-vm-manager skill](/Users/mike/.codex/skills/local-vm-manager/SKILL.md) before starting. This is the default for new browser VMs; do not create an ad hoc Tart, Lima, or macOS browser VM.

1. Check `local-vm-manager` MCP `vm_inventory` for an active job or cleanup blocker. Use `vm_start` and `vm_capture` for page captures, or `vm_run_playwright` for supported, explicitly selected web specs with the exact expected test count. Preserve the project's locked browser dependencies and unchanged source tests. The current Playwright profile supports trusted npm web projects and `tests/browser/*.spec.ts`; inspect its web-only build command and required inputs first. Report an unsupported layout or engine requirement instead of substituting a screenshot, fixture, different engine, or larger VM for the requested checks.
2. Renew the lease with `vm_renew` at least every 30 seconds while provisioning or working. For captures, request `vm_finish` after success or failure and poll `vm_status` until cleanup ends. Playwright jobs export and delete automatically after execution. The host supervisor and launchd sweeper enforce crash cleanup; an agent's final message or `finally` block is not sufficient.
3. Keep reports, screenshots, traces, logs and source hashes in the manager's bounded evidence directory outside iCloud. Verify `vm_deleted`, `runtime_deleted`, `evidence_complete`, and `evidence_verified`, plus the required artifacts. A passing suite also requires `test_result.passed` and the exact test count. An interrupted suite may correctly fail while cleanup succeeds; report both outcomes. `cleanup_blocked` is unfinished work and prevents another guest.
4. The manager owns only its new private runtime namespaces. Never adopt, start, stop, resize, prune, or delete an existing VM to follow this default. Never export a guest disk, browser profile, credentials, dependency tree, or toolchain as routine evidence. Preserve unrelated source edits and historical evidence.
5. Keep native macOS/iOS, Xcode, simulator, device, Safari-specific and other native test workflows under their existing instructions and authorization. Do not route them through Linux or change their tests, configuration, existing VMs, or acceptance requirements. Ordinary host browser checks continue to use Safari MCP; this default does not require a VM for every browser action.

If the MCP connection has not loaded the manager's tools, use its CLI through the same controller. On this Mac, VM CLI execution requires approved execution outside the shell sandbox for that invocation. Never launch a host Chromium browser as a fallback.

```sh
/Users/mike/Codex/local-vm-manager/bin/lvm run --url https://example.com --label browser-check
```

For Playwright, use `/Users/mike/Codex/local-vm-manager/bin/lvm playwright --source /absolute/local/web/repo --test tests/browser/example.spec.ts --expected-tests 1 --label web-check`; substitute the actual supported source, selected files, and count. The CLI renews its lease and waits for deletion. See the [manager README](/Users/mike/Codex/local-vm-manager/README.md) for prerequisites and status interpretation.
