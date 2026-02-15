import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, QueryResult } from "../types";
import { fetchWithTimeout } from "../utils/http";
import { loadOpencodeAuthEntry } from "../core/opencode-auth";

interface QuotaDetail {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
}

interface QuotaSnapshots {
  chat?: QuotaDetail;
  completions?: QuotaDetail;
  premium_interactions: QuotaDetail;
}

interface CopilotUsageResponse {
  copilot_plan: string;
  quota_reset_date: string;
  quota_snapshots: QuotaSnapshots;
}

interface CopilotTokenResponse {
  token: string;
}

interface BillingUsageItem {
  product: string;
  sku: string;
  model?: string;
  unitType: string;
  grossQuantity: number;
  netQuantity: number;
  limit?: number;
}

interface BillingUsageResponse {
  timePeriod: { year: number; month?: number };
  user: string;
  usageItems: BillingUsageItem[];
}

type CopilotTier = "free" | "pro" | "pro+" | "business" | "enterprise";

interface CopilotQuotaConfig {
  token: string;
  username: string;
  tier: CopilotTier;
}

interface CopilotAuthData {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}

interface CopilotCliConfig {
  copilot_tokens?: Record<string, string>;
  last_logged_in_user?: {
    host?: string;
    login?: string;
  };
}

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_QUOTA_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "copilot-quota-token.json",
);

const CANDIDATE_AUTH_PATHS = [
  path.join(os.homedir(), ".copilot", "config.json"),
  path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  path.join(os.homedir(), ".config", "opencode", "auth.json"),
  path.join(os.homedir(), ".opencode", "auth.json"),
];

const COPILOT_VERSION = "0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;

const COPILOT_HEADERS = {
  "User-Agent": USER_AGENT,
  "Editor-Version": EDITOR_VERSION,
  "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  "Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_PLAN_LIMITS: Record<CopilotTier, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

function createProgressBar(percent: number, width = 24): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function getResetCountdown(resetDate: string): string {
  const reset = new Date(resetDate);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();

  if (diffMs <= 0) return "soon";

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h`;
}

function formatMaybeNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return String(value);
}

function billingProjection(
  totalUsed: number,
  limit: number,
  period: { year: number; month?: number },
): { burnRate: string; projection: string } {
  if (!period.month) {
    return { burnRate: "n/a", projection: "n/a" };
  }

  const now = new Date();
  const sameMonth = now.getUTCFullYear() === period.year && now.getUTCMonth() + 1 === period.month;
  if (!sameMonth) {
    return { burnRate: "n/a", projection: "n/a" };
  }

  const day = Math.max(1, now.getUTCDate());
  const rate = totalUsed / day;
  if (!Number.isFinite(rate) || rate <= 0) {
    return { burnRate: "0/day", projection: "unlikely this period" };
  }

  const remaining = Math.max(0, limit - totalUsed);
  const daysLeft = remaining / rate;
  if (!Number.isFinite(daysLeft)) {
    return { burnRate: `${rate.toFixed(2)}/day`, projection: "n/a" };
  }

  const projected = new Date(now.getTime() + daysLeft * 24 * 60 * 60 * 1000);
  return {
    burnRate: `${rate.toFixed(2)}/day`,
    projection: projected.toISOString().replace("T", " ").slice(0, 19) + "Z",
  };
}

function readQuotaConfig(): CopilotQuotaConfig | null {
  try {
    if (!fs.existsSync(COPILOT_QUOTA_CONFIG_PATH)) {
      return null;
    }

    const content = fs.readFileSync(COPILOT_QUOTA_CONFIG_PATH, "utf-8");
    const config = JSON.parse(content) as CopilotQuotaConfig;

    const validTiers: CopilotTier[] = ["free", "pro", "pro+", "business", "enterprise"];
    if (!config.token || !config.username || !validTiers.includes(config.tier)) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

function maybeAuthObject(value: unknown): CopilotAuthData | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const access = typeof obj.access === "string" ? obj.access : undefined;
  const refresh = typeof obj.refresh === "string" ? obj.refresh : undefined;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const expires = typeof obj.expires === "number" ? obj.expires : undefined;

  if (!access && !refresh) return null;
  return { access, refresh, type, expires };
}

function isCopilotLabel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized.includes("copilot");
}

function findCopilotAuthInObject(value: unknown): CopilotAuthData | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  for (const key of ["github-copilot", "github_copilot", "copilot", "githubCopilot"]) {
    const found = maybeAuthObject(obj[key]);
    if (found) return found;
  }

  const providerKeys = ["providers", "auth", "accounts", "tokens"];
  for (const key of providerKeys) {
    const section = obj[key];
    if (!section || typeof section !== "object") continue;

    if (Array.isArray(section)) {
      for (const item of section) {
        if (!item || typeof item !== "object") continue;
        const itemObj = item as Record<string, unknown>;
        if (
          isCopilotLabel(itemObj.provider) ||
          isCopilotLabel(itemObj.id) ||
          isCopilotLabel(itemObj.name) ||
          isCopilotLabel(itemObj.type)
        ) {
          const found = maybeAuthObject(itemObj);
          if (found) return found;
        }
      }
    } else {
      const found = findCopilotAuthInObject(section);
      if (found) return found;
    }
  }

  return null;
}

function loadCopilotAuthData(): CopilotAuthData | null {
  const envOauth = process.env.COPILOT_OAUTH_TOKEN?.trim();
  if (envOauth) {
    return { type: "oauth", access: envOauth, refresh: envOauth };
  }

  const copilotConfigPath = path.join(os.homedir(), ".copilot", "config.json");
  try {
    if (fs.existsSync(copilotConfigPath)) {
      const raw = fs.readFileSync(copilotConfigPath, "utf8");
      const parsed = JSON.parse(raw) as CopilotCliConfig;
      const tokens = parsed.copilot_tokens ?? {};

      const host = parsed.last_logged_in_user?.host;
      const login = parsed.last_logged_in_user?.login;
      const preferredKey = host && login ? `${host}:${login}` : undefined;

      const token =
        (preferredKey ? tokens[preferredKey] : undefined) ??
        Object.values(tokens)[0];

      if (token) {
        return { type: "oauth", access: token, refresh: token };
      }
    }
  } catch {
    // Ignore parse errors and continue to fallback sources.
  }

  for (const p of CANDIDATE_AUTH_PATHS) {
    if (p === copilotConfigPath) continue;
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      const found = findCopilotAuthInObject(parsed);
      if (found) return found;
    } catch {
      // Ignore broken files and continue to next candidate path.
    }
  }

  return null;
}

async function fetchPublicBillingUsage(
  config: CopilotQuotaConfig,
): Promise<BillingUsageResponse> {
  const response = await fetchWithTimeout(
    `${GITHUB_API_BASE_URL}/users/${config.username}/settings/billing/premium_request/usage`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Copilot billing API error ${response.status}: ${errorText.slice(0, 240)}`);
  }

  return (await response.json()) as BillingUsageResponse;
}

async function exchangeForCopilotToken(oauthToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${oauthToken}`,
          ...COPILOT_HEADERS,
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const tokenData = (await response.json()) as CopilotTokenResponse;
    return tokenData.token;
  } catch {
    return null;
  }
}

function buildGitHubHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...COPILOT_HEADERS,
  };
}

function buildLegacyHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `token ${token}`,
    ...COPILOT_HEADERS,
  };
}

async function fetchCopilotUsage(authData: CopilotAuthData): Promise<CopilotUsageResponse> {
  const oauthToken = authData.refresh || authData.access;
  if (!oauthToken) {
    throw new Error("No OAuth token found in auth data.");
  }

  const cachedAccessToken = authData.access;
  const tokenExpiry = authData.expires || 0;

  if (cachedAccessToken && cachedAccessToken !== oauthToken && tokenExpiry > Date.now()) {
    const response = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
      headers: buildGitHubHeaders(cachedAccessToken),
    });

    if (response.ok) {
      return (await response.json()) as CopilotUsageResponse;
    }
  }

  const directResponse = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: buildLegacyHeaders(oauthToken),
  });

  if (directResponse.ok) {
    return (await directResponse.json()) as CopilotUsageResponse;
  }

  const copilotToken = await exchangeForCopilotToken(oauthToken);
  if (copilotToken) {
    const exchangedResponse = await fetchWithTimeout(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
      headers: buildGitHubHeaders(copilotToken),
    });

    if (exchangedResponse.ok) {
      return (await exchangedResponse.json()) as CopilotUsageResponse;
    }

    const errorText = await exchangedResponse.text();
    throw new Error(`Copilot API error ${exchangedResponse.status}: ${errorText.slice(0, 240)}`);
  }

  throw new Error("Copilot quota unavailable with current OAuth token.");
}

function formatQuotaLine(name: string, quota: QuotaDetail | undefined, width = 24): string {
  if (!quota) return "";

  if (quota.unlimited) {
    return `${name.padEnd(14)} Unlimited`;
  }

  const total = quota.entitlement;
  const used = total - quota.remaining;
  const percentRemaining = Math.round(quota.percent_remaining);
  const progressBar = createProgressBar(percentRemaining, width);

  return `${name.padEnd(14)} ${progressBar} ${percentRemaining}% remaining (${used}/${total})`;
}

function formatCopilotUsage(data: CopilotUsageResponse): string {
  const lines: string[] = [];

  lines.push(`Account     GitHub Copilot (${data.copilot_plan})`);
  lines.push("");

  const premium = data.quota_snapshots.premium_interactions;
  if (premium) {
    const premiumLine = formatQuotaLine("Premium", premium);
    if (premiumLine) lines.push(premiumLine);

    if (premium.overage_count > 0) {
      lines.push(`Overage     ${premium.overage_count} requests`);
    }
    lines.push(
      `PremiumRaw  entitlement=${formatMaybeNumber(premium.entitlement)} remaining=${formatMaybeNumber(
        premium.remaining,
      )} overagePermitted=${String(premium.overage_permitted)}`,
    );
  }

  const chat = data.quota_snapshots.chat;
  if (chat && !chat.unlimited) {
    const line = formatQuotaLine("Chat", chat);
    if (line) lines.push(line);
    lines.push(
      `ChatRaw     entitlement=${formatMaybeNumber(chat.entitlement)} remaining=${formatMaybeNumber(
        chat.remaining,
      )}`,
    );
  }

  const completions = data.quota_snapshots.completions;
  if (completions && !completions.unlimited) {
    const line = formatQuotaLine("Completion", completions);
    if (line) lines.push(line);
    lines.push(
      `CompRaw     entitlement=${formatMaybeNumber(
        completions.entitlement,
      )} remaining=${formatMaybeNumber(completions.remaining)}`,
    );
  }

  lines.push("");
  const resetCountdown = getResetCountdown(data.quota_reset_date);
  lines.push(`Resets      ${resetCountdown} (${data.quota_reset_date})`);

  return lines.join("\n");
}

function formatPublicBillingUsage(data: BillingUsageResponse, tier: CopilotTier): string {
  const lines: string[] = [];

  lines.push(`Account     GitHub Copilot (@${data.user})`);
  lines.push("");

  const premiumItems = data.usageItems.filter(
    (item) => item.sku === "Copilot Premium Request" || item.sku.includes("Premium"),
  );

  const totalUsed = premiumItems.reduce((sum, item) => sum + item.grossQuantity, 0);
  const limit = COPILOT_PLAN_LIMITS[tier];
  const remaining = Math.max(0, limit - totalUsed);
  const percentRemaining = Math.round((remaining / limit) * 100);
  const progressBar = createProgressBar(percentRemaining);

  lines.push(`Premium      ${progressBar} ${percentRemaining}% remaining (${totalUsed}/${limit})`);

  const projection = billingProjection(totalUsed, limit, data.timePeriod);
  lines.push(`BurnRate     ${projection.burnRate}`);
  lines.push(`Projected    ${projection.projection}`);

  const modelItems = data.usageItems.filter((item) => item.model && item.grossQuantity > 0);
  if (modelItems.length > 0) {
    lines.push("");
    lines.push("Model breakdown (gross/net/unit/limit):");
    const sortedItems = [...modelItems].sort((a, b) => b.grossQuantity - a.grossQuantity);
    for (const item of sortedItems) {
      lines.push(
        `${item.model}: ${item.grossQuantity}/${item.netQuantity} ${item.unitType} limit=${formatMaybeNumber(
          item.limit,
        )}`,
      );
    }
  }

  lines.push("");
  const period = data.timePeriod;
  const periodStr = period.month
    ? `${period.year}-${String(period.month).padStart(2, "0")}`
    : `${period.year}`;
  lines.push(`Period      ${periodStr}`);

  return lines.join("\n");
}

function formatCopilotSetupStatus(): string {
  const lines: string[] = [];
  lines.push("Account     Copilot auth not configured");
  lines.push("");
  lines.push(`PAT file    ${COPILOT_QUOTA_CONFIG_PATH}`);
  lines.push(`OAuth env   COPILOT_OAUTH_TOKEN`);
  lines.push("OAuth files");
  for (const p of CANDIDATE_AUTH_PATHS) {
    lines.push(`- ${p}${fs.existsSync(p) ? " (found)" : " (missing)"}`);
  }
  return lines.join("\n");
}

async function queryCopilotUsage(): Promise<QueryResult> {
  const quotaConfig = readQuotaConfig();
  if (quotaConfig) {
    try {
      const billingUsage = await fetchPublicBillingUsage(quotaConfig);
      return {
        success: true,
        output: formatPublicBillingUsage(billingUsage, quotaConfig.tier),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const copilotPrimary = loadCopilotAuthData();
  const opencodeCopilot = await loadOpencodeAuthEntry("github-copilot");
  const opencodeFallback =
    opencodeCopilot && (opencodeCopilot.access || opencodeCopilot.refresh)
      ? {
          type: opencodeCopilot.type,
          access: opencodeCopilot.access,
          refresh: opencodeCopilot.refresh,
          expires: opencodeCopilot.expires,
        }
      : null;
  const authData = copilotPrimary ?? opencodeFallback;
  if (!authData) {
    return {
      success: true,
      output: formatCopilotSetupStatus(),
    };
  }

  try {
    const usage = await fetchCopilotUsage(authData);
    return {
      success: true,
      output: formatCopilotUsage(usage),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const copilotProvider: Provider = {
  id: "copilot",
  label: "Copilot",
  query: queryCopilotUsage,
};
