import os from "node:os";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type { Provider, QueryResult } from "../types";
import { fetchWithTimeout } from "../utils/http";

interface GoogleQuotaResponse {
  models: Record<
    string,
    {
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
    }
  >;
}

interface GeminiOauthCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

interface GeminiAccounts {
  active?: string;
  old?: string[];
}

interface GeminiSettings {
  security?: {
    auth?: unknown;
  };
  mcpServers?: Record<string, unknown>;
}

interface GeminiState {
  tipsShown?: number;
}

interface GeminiChatMessage {
  model?: string;
}

interface GeminiChatSession {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiChatMessage[];
}

interface ModelQuota {
  displayName: string;
  remainPercent: number;
  resetTimeDisplay: string;
}

interface ModelConfig {
  key: string;
  altKey?: string;
  display: string;
}

const GOOGLE_QUOTA_API_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const USER_AGENT = "antigravity/1.11.9 windows/amd64";
const HIGH_USAGE_THRESHOLD = 90;

const GOOGLE_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "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";

const MODELS_TO_DISPLAY: ModelConfig[] = [
  { key: "gemini-3-pro-high", altKey: "gemini-3-pro-low", display: "G3 Pro" },
  { key: "gemini-3-pro-image", display: "G3 Image" },
  { key: "gemini-3-flash", display: "G3 Flash" },
  {
    key: "claude-opus-4-5-thinking",
    altKey: "claude-opus-4-5",
    display: "Claude",
  },
];

function geminiDir(): string {
  return path.join(os.homedir(), ".gemini");
}

function geminiOauthPath(): string {
  return path.join(geminiDir(), "oauth_creds.json");
}

function geminiAccountsPath(): string {
  return path.join(geminiDir(), "google_accounts.json");
}

function geminiInstallationIdPath(): string {
  return path.join(geminiDir(), "installation_id");
}

function geminiSettingsPath(): string {
  return path.join(geminiDir(), "settings.json");
}

function geminiStatePath(): string {
  return path.join(geminiDir(), "state.json");
}

function geminiTrustedFoldersPath(): string {
  return path.join(geminiDir(), "trustedFolders.json");
}

function geminiTmpPath(): string {
  return path.join(geminiDir(), "tmp");
}

function resolveProjectId(): string | null {
  return (
    process.env.GEMINI_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    null
  );
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return (await readFile(filePath, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function maskToken(token?: string): string {
  if (!token) return "missing";
  if (token.length <= 8) return "present";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function collectChatSessionFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }

        if (
          entry.isFile() &&
          fullPath.includes(`${path.sep}chats${path.sep}`) &&
          entry.name.endsWith(".json")
        ) {
          found.push(fullPath);
        }
      }),
    );
  }

  await walk(dir);
  return found;
}

async function collectGeminiSessionTelemetry(): Promise<{
  sessionCount: number;
  recentModels: string[];
  lastUpdated: string | null;
}> {
  const files = await collectChatSessionFiles(geminiTmpPath());
  if (files.length === 0) {
    return { sessionCount: 0, recentModels: [], lastUpdated: null };
  }

  const models = new Set<string>();
  let latestTs = 0;

  for (const filePath of files) {
    const session = await readJsonIfExists<GeminiChatSession>(filePath);
    if (!session) continue;

    const lastUpdated = session.lastUpdated ? Date.parse(session.lastUpdated) : Number.NaN;
    if (Number.isFinite(lastUpdated)) {
      latestTs = Math.max(latestTs, lastUpdated);
    }

    for (const message of session.messages ?? []) {
      if (message.model) {
        models.add(message.model);
      }
    }
  }

  return {
    sessionCount: files.length,
    recentModels: Array.from(models).slice(0, 8),
    lastUpdated: latestTs > 0 ? formatEpochMs(latestTs) : null,
  };
}

function formatResetTimeShort(isoTime: string): string {
  if (!isoTime) return "-";

  const resetDate = new Date(isoTime);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  if (!Number.isFinite(diffMs)) return "-";
  if (diffMs <= 0) return "reset";

  const diffMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatEpochMs(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function createProgressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"#".repeat(full)}${".".repeat(width - full)}]`;
}

function safeMax(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((max, v) => (v > max ? v : max), values[0] ?? 0);
}

function extractModelQuotas(data: GoogleQuotaResponse): ModelQuota[] {
  const quotas: ModelQuota[] = [];

  for (const modelConfig of MODELS_TO_DISPLAY) {
    let modelInfo = data.models[modelConfig.key];

    if (!modelInfo && modelConfig.altKey) {
      modelInfo = data.models[modelConfig.altKey];
    }

    if (modelInfo) {
      const remainingFraction = modelInfo.quotaInfo?.remainingFraction ?? 0;
      quotas.push({
        displayName: modelConfig.display,
        remainPercent: Math.round(remainingFraction * 100),
        resetTimeDisplay: formatResetTimeShort(modelInfo.quotaInfo?.resetTime ?? ""),
      });
    }
  }

  return quotas;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetchWithTimeout(
    GOOGLE_TOKEN_REFRESH_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    },
    12000,
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google token refresh error ${response.status}: ${errorText.slice(0, 240)}`);
  }

  return (await response.json()) as { access_token: string; expires_in: number };
}

async function fetchGoogleUsage(
  accessToken: string,
  projectId: string,
): Promise<GoogleQuotaResponse> {
  const response = await fetchWithTimeout(GOOGLE_QUOTA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ project: projectId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google quota API error ${response.status}: ${errorText.slice(0, 240)}`);
  }

  return (await response.json()) as GoogleQuotaResponse;
}

function formatLocalDetails(
  email: string,
  oauth: GeminiOauthCreds | null,
  accounts: GeminiAccounts | null,
  installationId: string | null,
  settings: GeminiSettings | null,
  state: GeminiState | null,
  trustedFolders: unknown,
  projectId: string | null,
  telemetry: { sessionCount: number; recentModels: string[]; lastUpdated: string | null },
): string {
  const lines: string[] = [];
  lines.push(`### ${email}`);
  lines.push("");
  lines.push(`Mode         Local .gemini details`);
  lines.push(`Project      ${projectId ?? "not set"}`);
  lines.push(`InstallId    ${installationId ?? "missing"}`);
  lines.push(`AccessToken  ${maskToken(oauth?.access_token)}`);
  lines.push(`RefreshToken ${maskToken(oauth?.refresh_token)}`);

  if (typeof oauth?.expiry_date === "number") {
    const expired = oauth.expiry_date <= Date.now();
    lines.push(`Expiry       ${formatEpochMs(oauth.expiry_date)} (${expired ? "expired" : "valid"})`);
  } else {
    lines.push(`Expiry       unknown`);
  }

  lines.push(`ActiveUser   ${accounts?.active ?? "unknown"}`);
  lines.push(`OldUsers     ${Array.isArray(accounts?.old) ? accounts!.old!.length : 0}`);
  lines.push(`MCP Servers  ${settings?.mcpServers ? Object.keys(settings.mcpServers).length : 0}`);
  lines.push(`TipsShown    ${typeof state?.tipsShown === "number" ? state.tipsShown : "unknown"}`);
  lines.push(`TrustFolders ${Array.isArray(trustedFolders) ? trustedFolders.length : 0}`);
  lines.push(`Sessions     ${telemetry.sessionCount}`);
  lines.push(`LastSession  ${telemetry.lastUpdated ?? "unknown"}`);
  lines.push(`Models       ${telemetry.recentModels.length ? telemetry.recentModels.join(", ") : "none"}`);

  return lines.join("\n");
}

function formatQuotaSection(models: ModelQuota[]): string {
  const lines: string[] = [];
  lines.push("Quota        API response");

  if (models.length === 0) {
    lines.push("No quota data.");
    return lines.join("\n");
  }

  lines.push("");
  for (const model of models) {
    lines.push(
      `${model.displayName.padEnd(10)} ${model.resetTimeDisplay.padEnd(10)} ${createProgressBar(model.remainPercent, 20)} ${model.remainPercent}%`,
    );
  }

  const maxUsage = safeMax(models.map((m) => 100 - m.remainPercent));
  if (maxUsage >= HIGH_USAGE_THRESHOLD) {
    lines.push("");
    lines.push("High usage warning.");
  }

  return lines.join("\n");
}

async function queryGeminiUsage(): Promise<QueryResult> {
  try {
    const [oauth, accounts, installationId, settings, state, trustedFolders] = await Promise.all([
      readJsonIfExists<GeminiOauthCreds>(geminiOauthPath()),
      readJsonIfExists<GeminiAccounts>(geminiAccountsPath()),
      readTextIfExists(geminiInstallationIdPath()),
      readJsonIfExists<GeminiSettings>(geminiSettingsPath()),
      readJsonIfExists<GeminiState>(geminiStatePath()),
      readJsonIfExists<unknown>(geminiTrustedFoldersPath()),
    ]);
    const telemetry = await collectGeminiSessionTelemetry();

    const projectId = resolveProjectId();
    const email = accounts?.active ?? "unknown";

    const sections: string[] = [];
    sections.push(
      formatLocalDetails(
        email,
        oauth,
        accounts,
        installationId,
        settings,
        state,
        trustedFolders,
        projectId,
        telemetry,
      ),
    );

    if (projectId && oauth) {
      try {
        const expired = typeof oauth.expiry_date === "number" && oauth.expiry_date <= Date.now();
        let accessToken = oauth.access_token?.trim() ?? "";

        if ((!accessToken || expired) && oauth.refresh_token) {
          const refreshed = await refreshAccessToken(oauth.refresh_token);
          accessToken = refreshed.access_token;
        }

        if (accessToken) {
          const data = await fetchGoogleUsage(accessToken, projectId);
          const models = extractModelQuotas(data);
          sections.push("");
          sections.push(formatQuotaSection(models));
        } else {
          sections.push("");
          sections.push("Quota        skipped (no usable access token)");
        }
      } catch (error) {
        sections.push("");
        sections.push(
          `Quota        unavailable (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } else {
      sections.push("");
      sections.push("Quota        skipped (project id not set)");
    }

    return {
      success: true,
      output: sections.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const geminiProvider: Provider = {
  id: "gemini",
  label: "Gemini",
  query: queryGeminiUsage,
};
