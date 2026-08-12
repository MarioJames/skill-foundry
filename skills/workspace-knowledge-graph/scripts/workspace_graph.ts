#!/usr/bin/env bun

import { main } from "./cli.ts";

if (import.meta.main) {
  process.exitCode = main();
}
