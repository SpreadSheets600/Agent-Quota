#!/usr/bin/env bun

import { providers } from "./app/providers";
import { queryProviders } from "./app/query";
import { renderOnce } from "./app/once";

const autoRefreshMs = Math.max(5000, Number(process.env.AGENT_STATUS_REFRESH_MS ?? "60000"));
const onceMode = process.argv.includes("--once");

if (onceMode) {
  const snapshot = await queryProviders(providers);
  process.stdout.write(`${renderOnce(snapshot)}\n`);
  process.exitCode = snapshot.status === "error" ? 1 : 0;
} else {
  const { runApp } = await import("./ui/main");
  await runApp(autoRefreshMs);
}
