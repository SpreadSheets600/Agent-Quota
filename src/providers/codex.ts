import { loadCodexTokens } from "../core/auth";
import type { Provider, QueryResult } from "../types";
import { parseJwt } from "../utils/jwt";
import { fetchWithTimeout } from "../utils/http";

interface RateLimitWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
}

interface OpenAIUsageResponse {
  plan_type: string;
  rate_limit: {
    limit_reached: boolean;
    primary_window: RateLimitWindow;
    secondary_window: RateLimitWindow | null;
  } | null;
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "now";
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function formatEpochMs(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatFutureTimeFromNow(seconds: number): string {
  const target = Date.now() + Math.max(0, seconds) * 1000;
  return formatEpochMs(target);
}

function progressBar(percentRemaining: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, percentRemaining));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function remainPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function windowLabel(seconds: number): string {
  const days = Math.round(seconds / 86400);
  if (days >= 1) {
    return `${days}-day window`;
  }
  return `${Math.max(1, Math.round(seconds / 3600))}-hour window`;
}

function formatWindow(window: RateLimitWindow): string[] {
  const remaining = remainPercent(window.used_percent);
  const used = Math.max(0, Math.min(100, Math.round(window.used_percent)));
  return [
    `${windowLabel(window.limit_window_seconds)}`,
    `${progressBar(remaining)} ${remaining}% remaining`,
    `used ${used}%`,
    `resets in ${formatDuration(window.reset_after_seconds)}`,
    `reset at ${formatFutureTimeFromNow(window.reset_after_seconds)}`,
  ];
}

async function fetchOpenAIUsage(
  accessToken: string,
  accountId: string | null,
): Promise<OpenAIUsageResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "agent-status/0.1.0",
  };

  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await fetchWithTimeout(OPENAI_USAGE_URL, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error ${response.status}: ${body.slice(0, 240)}`);
  }

  return (await response.json()) as OpenAIUsageResponse;
}

function formatOutput(
  data: OpenAIUsageResponse,
  accessToken: string,
  accountId: string | null,
  expiresAt: number | null,
): string {
  const payload = parseJwt(accessToken);
  const email = payload?.["https://api.openai.com/profile"]?.email ?? "unknown";

  const lines: string[] = [];
  lines.push(`Provider   Codex (OpenAI)`);
  lines.push(`Account    ${email}`);
  lines.push(`AccountId  ${accountId ?? "unknown"}`);
  lines.push(`Plan       ${data.plan_type}`);
  lines.push(`TokenExp   ${expiresAt ? formatEpochMs(expiresAt) : "unknown"}`);
  lines.push("");

  const primary = data.rate_limit?.primary_window;
  if (primary) {
    lines.push(...formatWindow(primary));
  } else {
    lines.push("No rate-limit data available.");
  }

  const secondary = data.rate_limit?.secondary_window;
  if (secondary) {
    lines.push("");
    lines.push(...formatWindow(secondary));
  }

  if (data.rate_limit?.limit_reached) {
    lines.push("");
    lines.push("Rate limit reached for at least one window.");
  }

  return lines.join("\n");
}

async function queryCodexUsage(): Promise<QueryResult> {
  const auth = await loadCodexTokens();

  if (auth.expiresAt && auth.expiresAt <= Date.now()) {
    return {
      success: false,
      error: "Codex access token is expired. Re-authenticate with codex login.",
    };
  }

  try {
    const usage = await fetchOpenAIUsage(auth.accessToken, auth.accountId);
    return {
      success: true,
      output: formatOutput(usage, auth.accessToken, auth.accountId, auth.expiresAt),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  query: queryCodexUsage,
};
