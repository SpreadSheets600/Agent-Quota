import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, QueryResult } from "../types";
import { fetchWithTimeout } from "../utils/http";

interface GeminiSettings {
  authType?: string;
  security?: {
    auth?: {
      selectedType?: string;
    };
  };
}

interface GeminiOAuthCreds {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
}

interface GeminiModelQuota {
  percentLeft: number;
  resetsIn: string;
  modelId: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: Array<{
    remainingFraction: number;
    resetTime: string;
    modelId: string;
  }>;
}

const GEMINI_DIR = path.join(os.homedir(), ".gemini");
const SETTINGS_PATH = path.join(GEMINI_DIR, "settings.json");
const OAUTH_CREDS_PATH = path.join(GEMINI_DIR, "oauth_creds.json");

const QUOTA_API = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const LOAD_CODE_ASSIST_API = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const TOKEN_REFRESH_API = "https://oauth2.googleapis.com/token";
const PROJECTS_API = "https://cloudresourcemanager.googleapis.com/v1/projects";

const GEMINI_OAUTH2_RELATIVE_PATH = path.join(
  "node_modules",
  "@google",
  "gemini-cli-core",
  "dist",
  "src",
  "code_assist",
  "oauth2.js",
);

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Ignore write errors.
  }
}

function cleanString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveGeminiAuthType(settings: GeminiSettings | null): string {
  return cleanString(settings?.authType) ?? cleanString(settings?.security?.auth?.selectedType) ?? "oauth-personal";
}

function resolveGeminiBinaryPath(): string | null {
  for (const envKey of ["GEMINI_PATH", "GEMINI_CLI_PATH"]) {
    const fromEnv = cleanString(process.env[envKey]);
    if (fromEnv && fs.existsSync(fromEnv)) {
      return fromEnv;
    }
  }

  const pathEnv = cleanString(process.env.PATH);
  if (pathEnv) {
    for (const dir of pathEnv.split(path.delimiter)) {
      const candidate = path.join(dir, "gemini");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const commonCandidates = [
    path.join(os.homedir(), ".local", "bin", "gemini"),
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
    "/usr/bin/gemini",
  ];
  for (const candidate of commonCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findGeminiOauth2FilePath(binaryPath: string): string | null {
  try {
    const realPath = fs.realpathSync(binaryPath);
    let currentDir = path.dirname(realPath);

    for (let i = 0; i < 8; i += 1) {
      const directCorePath = path.join(currentDir, GEMINI_OAUTH2_RELATIVE_PATH);
      if (fs.existsSync(directCorePath)) return directCorePath;

      const nestedCliPath = path.join(currentDir, "@google", "gemini-cli", GEMINI_OAUTH2_RELATIVE_PATH);
      if (fs.existsSync(nestedCliPath)) return nestedCliPath;

      const homebrewPath = path.join(
        currentDir,
        "libexec",
        "lib",
        "node_modules",
        "@google",
        "gemini-cli",
        GEMINI_OAUTH2_RELATIVE_PATH,
      );
      if (fs.existsSync(homebrewPath)) return homebrewPath;

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {
    // Ignore and fallback to env credentials.
  }
  return null;
}

function resolveGeminiOAuthClientCredentials(): { clientId: string; clientSecret: string } | null {
  const envClientId = cleanString(process.env.GEMINI_OAUTH_CLIENT_ID);
  const envClientSecret = cleanString(process.env.GEMINI_OAUTH_CLIENT_SECRET);
  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  const binaryPath = resolveGeminiBinaryPath();
  if (!binaryPath) return null;

  const oauth2Path = findGeminiOauth2FilePath(binaryPath);
  if (!oauth2Path) return null;

  try {
    const content = fs.readFileSync(oauth2Path, "utf-8");
    const clientIdMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/);
    const clientSecretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/);
    if (!clientIdMatch || !clientSecretMatch) return null;
    return {
      clientId: clientIdMatch[1],
      clientSecret: clientSecretMatch[1],
    };
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64.length % 4;
    if (padding) base64 += "=".repeat(4 - padding);
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatResetTime(isoTime: string): string {
  const resetDate = new Date(isoTime);
  const diffMs = resetDate.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "unknown";
  if (diffMs <= 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

async function refreshAccessToken(
  creds: GeminiOAuthCreds,
): Promise<{ accessToken: string; expiryDate: number } | null> {
  if (!creds.refresh_token) return null;
  const clientCreds = resolveGeminiOAuthClientCredentials();
  if (!clientCreds) return null;

  try {
    const body = new URLSearchParams({
      client_id: clientCreds.clientId,
      client_secret: clientCreds.clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(
      TOKEN_REFRESH_API,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      15000,
    );

    if (!response.ok) return null;

    const data = (await response.json()) as { access_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      expiryDate: Date.now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}

async function fetchTierAndProjectId(
  accessToken: string,
): Promise<{ tier: "Paid" | "Workspace" | "Free" | "Legacy" | "Unknown"; projectId?: string }> {
  try {
    const response = await fetchWithTimeout(
      LOAD_CODE_ASSIST_API,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
      },
      15000,
    );

    if (!response.ok) return { tier: "Unknown" };

    const data = (await response.json()) as Record<string, unknown>;
    const tierStr = ((data.currentTier as { id?: string } | undefined)?.id ?? "").toLowerCase();
    const projectId = typeof data.cloudaicompanionProject === "string" ? data.cloudaicompanionProject : undefined;

    if (tierStr === "standard-tier" || tierStr === "g1-pro-tier") return { tier: "Paid", projectId };
    if (tierStr === "free-tier") return { tier: "Free", projectId };
    if (tierStr === "legacy-tier") return { tier: "Legacy", projectId };
    return { tier: "Unknown", projectId };
  } catch {
    return { tier: "Unknown" };
  }
}

async function fetchProjectId(accessToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      PROJECTS_API,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      15000,
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      projects?: Array<{ projectId: string; labels?: Record<string, string> }>;
    };
    for (const project of data.projects ?? []) {
      if (project.projectId.startsWith("gen-lang-client")) return project.projectId;
      if (project.labels?.["generative-language"]) return project.projectId;
    }
    return null;
  } catch {
    return null;
  }
}

function parseHighestQuotaModels(data: RetrieveUserQuotaResponse): {
  proModel: GeminiModelQuota | null;
  flashModel: GeminiModelQuota | null;
} {
  const buckets = data.buckets ?? [];

  function version(modelId: string): number {
    const match = modelId.match(/gemini-(\d+(?:\.\d+)?)/i);
    return match ? Number.parseFloat(match[1]) : 0;
  }

  let proModel: GeminiModelQuota | null = null;
  let proVersion = 0;
  let flashModel: GeminiModelQuota | null = null;
  let flashVersion = 0;

  for (const bucket of buckets) {
    const modelId = bucket.modelId ?? "";
    const lower = modelId.toLowerCase();
    const v = version(modelId);
    const quota: GeminiModelQuota = {
      modelId,
      percentLeft: Math.max(0, Math.min(100, Math.round((bucket.remainingFraction ?? 0) * 100))),
      resetsIn: formatResetTime(bucket.resetTime),
    };

    if (lower.includes("pro") && !lower.includes("flash")) {
      if (v > proVersion) {
        proModel = quota;
        proVersion = v;
      }
    } else if (lower.includes("flash")) {
      if (v > flashVersion) {
        flashModel = quota;
        flashVersion = v;
      }
    }
  }

  return { proModel, flashModel };
}

async function fetchQuota(
  accessToken: string,
  projectId?: string,
): Promise<{ proModel: GeminiModelQuota | null; flashModel: GeminiModelQuota | null }> {
  try {
    const body = projectId ? { project: projectId } : {};
    const response = await fetchWithTimeout(
      QUOTA_API,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      15000,
    );
    if (!response.ok) return { proModel: null, flashModel: null };
    const data = (await response.json()) as RetrieveUserQuotaResponse;
    return parseHighestQuotaModels(data);
  } catch {
    return { proModel: null, flashModel: null };
  }
}

function formatOutput(input: {
  email: string;
  tier: "Paid" | "Workspace" | "Free" | "Legacy" | "Unknown";
  projectId: string | null;
  proModel: GeminiModelQuota | null;
  flashModel: GeminiModelQuota | null;
}): string {
  const lines: string[] = [];
  lines.push(`Account      ${input.email}`);
  lines.push(`Tier         ${input.tier}`);
  lines.push(`Project      ${input.projectId ?? "unknown"}`);
  lines.push("");

  if (input.proModel) {
    lines.push(
      `Pro          ${bar(input.proModel.percentLeft)} ${input.proModel.percentLeft}% remaining (${input.proModel.resetsIn})`,
    );
    lines.push(`ProModel     ${input.proModel.modelId}`);
  } else {
    lines.push("Pro          unavailable");
  }

  if (input.flashModel) {
    lines.push(
      `Flash        ${bar(input.flashModel.percentLeft)} ${input.flashModel.percentLeft}% remaining (${input.flashModel.resetsIn})`,
    );
    lines.push(`FlashModel   ${input.flashModel.modelId}`);
  } else {
    lines.push("Flash        unavailable");
  }

  return lines.join("\n");
}

async function queryGeminiUsage(): Promise<QueryResult> {
  try {
    const settings = readJsonFile<GeminiSettings>(SETTINGS_PATH);
    const authType = resolveGeminiAuthType(settings);
    if (authType === "api-key" || authType === "vertex-ai") {
      return {
        success: true,
        output: `Quota        skipped (unsupported auth type: ${authType}; use OAuth)`,
      };
    }

    const creds = readJsonFile<GeminiOAuthCreds>(OAUTH_CREDS_PATH);
    if (!creds?.access_token) {
      return {
        success: true,
        output: "Quota        skipped (Gemini OAuth not configured, run `gemini`)",
      };
    }

    let accessToken = creds.access_token;
    const expired = typeof creds.expiry_date === "number" && creds.expiry_date < Date.now();
    if (expired) {
      const refreshed = await refreshAccessToken(creds);
      if (!refreshed) {
        return {
          success: true,
          output: "Quota        unavailable (OAuth token expired and refresh failed)",
        };
      }
      accessToken = refreshed.accessToken;
      writeJsonFile(OAUTH_CREDS_PATH, {
        ...creds,
        access_token: refreshed.accessToken,
        expiry_date: refreshed.expiryDate,
      });
    }

    const payload = creds.id_token ? decodeJwtPayload(creds.id_token) : null;
    const email = (typeof payload?.email === "string" ? payload.email : null) ?? "unknown";

    const tierInfo = await fetchTierAndProjectId(accessToken);
    const projectId = tierInfo.projectId ?? (await fetchProjectId(accessToken));
    const { proModel, flashModel } = await fetchQuota(accessToken, projectId ?? undefined);

    return {
      success: true,
      output: formatOutput({
        email,
        tier: tierInfo.tier,
        projectId,
        proModel,
        flashModel,
      }),
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

