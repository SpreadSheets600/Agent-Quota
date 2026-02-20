import type { Provider, QueryResult } from "../types";
import { loadOpencodeAuthEntry } from "../core/opencode-auth";
import { fetchWithTimeout } from "../utils/http";

interface ZaiApiUsageDetail {
  modelCode: string;
  usage: number;
}

interface ZaiApiLimitEntry {
  type: string;
  unit: number;
  number: number;
  usage: number | null;
  currentValue: number | null;
  remaining: number | null;
  percentage: number;
  usageDetails?: ZaiApiUsageDetail[] | null;
  nextResetTime: number | null;
}

interface ZaiApiResponse {
  code: number;
  msg: string;
  success: boolean;
  data?: {
    limits?: ZaiApiLimitEntry[];
    planName?: string;
    plan?: string;
    plan_type?: string;
    packageName?: string;
  };
}

const ZAI_USAGE_API = "https://api.z.ai/api/monitor/usage/quota/limit";

function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function unitLabel(unit: number): string {
  if (unit === 1) return "day";
  if (unit === 3) return "hour";
  if (unit === 5) return "minute";
  return "unit";
}

function formatReset(epochMs: number | null): string {
  if (!epochMs) return "unknown";
  const diffMs = epochMs - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.floor(diffMs / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function loadZaiToken(): Promise<string | null> {
  const envToken =
    process.env.ZAI_API_TOKEN?.trim() || process.env.ZAI_AUTH_TOKEN?.trim() || process.env.ZHIPU_API_TOKEN?.trim() || null;
  if (envToken) return envToken;

  const candidates = ["zai", "z-ai", "zhipu", "glm"];
  for (const name of candidates) {
    const entry = await loadOpencodeAuthEntry(name);
    const token = entry?.access?.trim() || entry?.refresh?.trim() || entry?.key?.trim();
    if (token) return token;
  }
  return null;
}

function formatLimitLine(label: string, entry: ZaiApiLimitEntry): string {
  const percentRemaining = Math.max(0, Math.min(100, Math.round(100 - entry.percentage)));
  const used = entry.usage ?? entry.currentValue ?? 0;
  const remaining = entry.remaining ?? 0;
  const window = `${entry.number}${unitLabel(entry.unit)}${entry.number > 1 ? "s" : ""}`;
  return `${label.padEnd(11)} ${window.padEnd(8)} ${bar(percentRemaining)} ${percentRemaining}% remaining (${used}/${used + remaining})`;
}

function formatOutput(data: ZaiApiResponse): string {
  if (!data.success || data.code !== 200) {
    return `Quota        unavailable (${data.msg || "API error"})`;
  }
  const limits = data.data?.limits ?? [];
  const tokenLimit = limits.find((limit) => limit.type === "TOKENS_LIMIT");
  const timeLimit = limits.find((limit) => limit.type === "TIME_LIMIT");

  const plan =
    data.data?.planName ?? data.data?.plan ?? data.data?.plan_type ?? data.data?.packageName ?? "unknown";

  const lines: string[] = [];
  lines.push(`Plan         ${plan}`);
  lines.push("");

  if (tokenLimit) {
    lines.push(formatLimitLine("Token", tokenLimit));
    lines.push(`TokenReset   ${formatReset(tokenLimit.nextResetTime)} (${tokenLimit.nextResetTime ?? "unknown"})`);
    const models = tokenLimit.usageDetails?.filter((item) => item.usage > 0) ?? [];
    if (models.length > 0) {
      lines.push("ModelUsage   " + models.map((item) => `${item.modelCode}:${item.usage}`).join(", "));
    }
    lines.push("");
  }

  if (timeLimit) {
    lines.push(formatLimitLine("Time", timeLimit));
    lines.push(`TimeReset    ${formatReset(timeLimit.nextResetTime)} (${timeLimit.nextResetTime ?? "unknown"})`);
  }

  if (!tokenLimit && !timeLimit) {
    lines.push("Quota        unavailable (no limits found)");
  }

  return lines.join("\n");
}

async function queryZaiUsage(): Promise<QueryResult> {
  const token = await loadZaiToken();
  if (!token) {
    return {
      success: true,
      output: "Quota        skipped (set ZAI_API_TOKEN or ZHIPU_API_TOKEN)",
    };
  }

  try {
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    const response = await fetchWithTimeout(ZAI_USAGE_API, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
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
        error: `z.ai API error ${response.status}: ${body.slice(0, 240)}`,
      };
    }

    const data = (await response.json()) as ZaiApiResponse;
    return { success: true, output: formatOutput(data) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const zaiProvider: Provider = {
  id: "zai",
  label: "z.ai",
  query: queryZaiUsage,
};

