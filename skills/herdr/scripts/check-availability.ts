#!/usr/bin/env bun

import {
  checkHerdrAvailability,
  emit,
  parseFlags,
  runCli,
} from "./lib/herdr-route";

const usage = "Usage: check-availability.ts";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), [], ["--help"]);
  if (flags.has("--help")) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const availability = checkHerdrAvailability();
  emit({
    ok: true,
    use_herdr: availability.available,
    reason: availability.reason,
    fallback: availability.available ? null : "normal-channel",
  });
});
