#!/usr/bin/env bun

import { runHookEventCli } from "../scripts/hook_runtime.ts";

process.exitCode = await runHookEventCli("clean");
