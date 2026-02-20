import type { Provider, QueryResult } from "../types";
import { loadOpencodeAuthEntry } from "../core/opencode-auth";
import { fetchWithTimeout } from "../utils/http";

interface DroidUsageTier {
  userTokens: number;
  orgTotalTokensUsed: number;
  orgOverageUsed: number;
  basicAllowance: number;
  totalAllowance: number;
  orgOverageLimit: number;
  usedRatio: number;
}

interface DroidUsageResponse {
  usage?: {
    startDate?: number;
    endDate?: number;
    standard?: Partial<DroidUsageTier>;
    premium?: Partial<DroidUsageTier>;
  };
}

const DROID_USAGE_API = "https://api.factory.ai/api/organization/subscription/schedule";

function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function normalizePercentUsed(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 1) return Math.max(0, Math.min(100, Math.round(raw * 100)));
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function fmtDate(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "unknown";
  const d = new Date(epochMs);
  if (!Number.isFinite(d.getTime())) return "unknown";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function loadDroidToken(): Promise<string | null> {
  const envToken =
    process.env.DROID_AUTH_TOKEN?.trim() ||
    process.env.DROID_API_TOKEN?.trim() ||
    process.env.FACTORY_AUTH_TOKEN?.trim() ||
    null;
  if (envToken) return envToken;

  const candidates = ["droid", "factory", "factory-ai"];
  for (const name of candidates) {
    const entry = await loadOpencodeAuthEntry(name);
    const token = entry?.access?.trim() || entry?.refresh?.trim() || entry?.key?.trim();
    if (token) return token;
  }

  return null;
}

function tierLine(label: string, tier: Partial<DroidUsageTier> | undefined): string {
  const usedPercent = normalizePercentUsed(Number(tier?.usedRatio ?? 0));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const total = Number(tier?.totalAllowance ?? 0);
  const used = Number(tier?.orgTotalTokensUsed ?? 0);
  return `${label.padEnd(12)} ${bar(remainingPercent)} ${remainingPercent}% remaining (${used}/${total})`;
}

function formatOutput(data: DroidUsageResponse): string {
  const usage = data.usage;
  if (!usage) {
    return "Quota        unavailable (missing usage data)";
  }

  const lines: string[] = [];
  lines.push("Provider     Factory Droid");
  lines.push(`WindowStart  ${fmtDate(usage.startDate)}`);
  lines.push(`WindowEnd    ${fmtDate(usage.endDate)}`);
  lines.push("");
  lines.push(tierLine("Standard", usage.standard));
  lines.push(tierLine("Premium", usage.premium));
  return lines.join("\n");
}

async function queryDroidUsage(): Promise<QueryResult> {
  const token = await loadDroidToken();
  if (!token) {
    return {
      success: true,
      output: "Quota        skipped (set DROID_AUTH_TOKEN or FACTORY_AUTH_TOKEN)",
    };
  }

  try {
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    const response = await fetchWithTimeout(DROID_USAGE_API, {
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
        error: `Droid API error ${response.status}: ${body.slice(0, 240)}`,
      };
    }

    const data = (await response.json()) as DroidUsageResponse;
    return {
      success: true,
      output: formatOutput(data),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const droidProvider: Provider = {
  id: "droid",
  label: "Droid",
  query: queryDroidUsage,
};

