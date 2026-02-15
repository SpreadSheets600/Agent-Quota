import { parseJwt } from "../utils/jwt";
import type { Provider, QueryResult } from "../types";
import { knownAuthPaths, loadOpencodeAuth } from "../core/opencode-auth";

function formatEpochMs(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function summarizeAuthEntry(name: string, entry: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const access = typeof entry.access === "string" ? entry.access : undefined;
  const refresh = typeof entry.refresh === "string" ? entry.refresh : undefined;
  const key = typeof entry.key === "string" ? entry.key : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;

  lines.push(`- ${name}`);
  lines.push(`  type=${typeof entry.type === "string" ? entry.type : "unknown"}`);
  lines.push(`  access=${access ? "present" : "missing"}`);
  lines.push(`  refresh=${refresh ? "present" : "missing"}`);
  lines.push(`  key=${key ? "present" : "missing"}`);

  if (expires) {
    lines.push(`  expires=${formatEpochMs(expires)}`);
  }

  if (access) {
    const payload = parseJwt(access);
    const email = payload?.["https://api.openai.com/profile"]?.email;
    if (email) {
      lines.push(`  email=${email}`);
    }
  }

  return lines;
}

async function queryOpenCodeStatus(): Promise<QueryResult> {
  const auth = await loadOpencodeAuth();
  if (!auth) {
    return {
      success: true,
      output: `No auth file found in: ${knownAuthPaths().join(", ")}`,
    };
  }

  const lines: string[] = [];
  lines.push(`AuthFiles   ${knownAuthPaths().join(", ")}`);
  lines.push("");

  const keys = Object.keys(auth);
  if (keys.length === 0) {
    lines.push("No providers found.");
  } else {
    for (const key of keys) {
      const entry = auth[key];
      if (!entry || typeof entry !== "object") continue;
      lines.push(...summarizeAuthEntry(key, entry as Record<string, unknown>));
      lines.push("");
    }
  }

  return {
    success: true,
    output: lines.join("\n").trim(),
  };
}

export const opencodeProvider: Provider = {
  id: "opencode",
  label: "OpenCode",
  query: queryOpenCodeStatus,
};
