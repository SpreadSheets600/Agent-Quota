import type { Provider, QueryResult } from "../types";
import { loadOpencodeAuthEntry } from "../core/opencode-auth";
import { fetchWithTimeout } from "../utils/http";

interface KimiApiUsage {
  scope: string;
  detail: {
    limit: string;
    used: string;
    remaining: string;
    resetTime: string;
  };
  limits?: Array<{
    window: {
      duration: number;
      timeUnit: string;
    };
    detail: {
      limit: string;
      used: string;
      remaining: string;
      resetTime: string;
    };
  }>;
}

interface KimiApiResponse {
  usages?: KimiApiUsage[];
}

const KIMI_USAGE_API = "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages";

function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function formatReset(isoTime: string): string {
  const d = new Date(isoTime);
  const diffMs = d.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "unknown";
  if (diffMs <= 0) return "now";
  const minutes = Math.floor(diffMs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function loadKimiToken(): Promise<string | null> {
  const envToken =
    process.env.KIMI_AUTH_TOKEN?.trim() || process.env.KIMI_API_TOKEN?.trim() || process.env.MOONSHOT_API_TOKEN?.trim() || null;
  if (envToken) return envToken;

  const candidates = ["kimi", "moonshot", "moonshotai"];
  for (const name of candidates) {
    const entry = await loadOpencodeAuthEntry(name);
    const token = entry?.access?.trim() || entry?.refresh?.trim() || entry?.key?.trim();
    if (token) return token;
  }
  return null;
}

function toInt(value: string): number {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : 0;
}

function formatOutput(data: KimiApiResponse): string {
  const codingUsage = data.usages?.find((item) => item.scope === "FEATURE_CODING");
  if (!codingUsage) {
    return "Quota        unavailable (no FEATURE_CODING usage in response)";
  }

  const weekly = codingUsage.detail;
  const weeklyLimit = toInt(weekly.limit);
  const weeklyRemaining = toInt(weekly.remaining);
  const weeklyPercent = weeklyLimit > 0 ? Math.round((weeklyRemaining / weeklyLimit) * 100) : 0;

  const rateLimit = codingUsage.limits?.[0];
  const lines: string[] = [];
  lines.push("Provider     Kimi");
  lines.push("");
  lines.push(
    `Weekly       ${bar(weeklyPercent)} ${weeklyPercent}% remaining (${toInt(weekly.used)}/${weeklyLimit})`,
  );
  lines.push(`WeeklyReset  ${formatReset(weekly.resetTime)} (${weekly.resetTime})`);

  if (rateLimit) {
    const rLimit = toInt(rateLimit.detail.limit);
    const rRemaining = toInt(rateLimit.detail.remaining);
    const rPercent = rLimit > 0 ? Math.round((rRemaining / rLimit) * 100) : 0;
    lines.push("");
    lines.push(
      `Rate ${rateLimit.window.duration}m${" ".repeat(Math.max(1, 5 - String(rateLimit.window.duration).length))}` +
        `${bar(rPercent)} ${rPercent}% remaining (${toInt(rateLimit.detail.used)}/${rLimit})`,
    );
    lines.push(`RateReset    ${formatReset(rateLimit.detail.resetTime)} (${rateLimit.detail.resetTime})`);
  }

  return lines.join("\n");
}

async function queryKimiUsage(): Promise<QueryResult> {
  const token = await loadKimiToken();
  if (!token) {
    return {
      success: true,
      output: "Quota        skipped (set KIMI_AUTH_TOKEN or MOONSHOT_API_TOKEN)",
    };
  }

  try {
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    const response = await fetchWithTimeout(KIMI_USAGE_API, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: ["FEATURE_CODING"] }),
    });

    if (response.status === 401) {
      return {
        success: true,
        output: "Quota        unavailable (token unauthorized/expired)",
      };
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: `Kimi API error ${response.status}: ${body.slice(0, 240)}`,
      };
    }

    const data = (await response.json()) as KimiApiResponse;
    return { success: true, output: formatOutput(data) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const kimiProvider: Provider = {
  id: "kimi",
  label: "Kimi",
  query: queryKimiUsage,
};

