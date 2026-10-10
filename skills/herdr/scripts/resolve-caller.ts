#!/usr/bin/env bun
import { emit, requireHerdr, resolveCaller, runCli } from "./lib/herdr-route";

await runCli(async () => {
  requireHerdr();
  emit({ ok: true, caller: await resolveCaller() });
});
