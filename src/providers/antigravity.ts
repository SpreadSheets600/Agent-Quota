import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";
import type { Provider, QueryResult } from "../types";

const execFileAsync = promisify(execFile);

const USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const MODEL_CONFIGS_PATH = "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs";
const TIMEOUT_MS = 8000;

interface ProcessInfo {
  pid: number;
  csrfToken: string;
  extensionPort: number | null;
}

interface AntigravityModelQuota {
  label: string;
  percentLeft: number;
  resetsIn: string;
}

function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const full = Math.round((clamped / 100) * width);
  return `[${"█".repeat(full)}${"·".repeat(width - full)}]`;
}

function defaultBody(): Record<string, unknown> {
  return {
    metadata: {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    },
  };
}

function isAntigravityCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (!lower.includes("language_server")) return false;
  if (lower.includes("antigravity")) return true;
  if (lower.includes("--app_data_dir") && lower.includes("codeium")) return true;
  return false;
}

function extractFlag(flag: string, command: string): string | null {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedFlag}[=\\s]+([^\\s]+)`, "i");
  const match = command.match(regex);
  return match?.[1] ?? null;
}

function extractNumberFlag(flag: string, command: string): number | null {
  const raw = extractFlag(flag, command);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

async function detectProcessInfo(): Promise<ProcessInfo> {
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,command="], {
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf-8",
  });

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!Number.isInteger(pid) || !isAntigravityCommand(command)) continue;

    const csrfToken = extractFlag("--csrf_token", command);
    if (!csrfToken) {
      throw new Error("Antigravity detected but csrf token was not found.");
    }

    return {
      pid,
      csrfToken,
      extensionPort: extractNumberFlag("--extension_server_port", command),
    };
  }

  throw new Error("Antigravity language server is not running.");
}

function parseListeningPorts(lsofOutput: string): number[] {
  const regex = /:(\d+)\s+\(LISTEN\)/g;
  const ports = new Set<number>();
  for (const match of lsofOutput.matchAll(regex)) {
    const val = Number(match[1]);
    if (Number.isInteger(val)) ports.add(val);
  }
  return [...ports];
}

async function detectPorts(pid: number): Promise<number[]> {
  const lsofPath = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => fs.existsSync(p));
  if (!lsofPath) return [];

  const { stdout } = await execFileAsync(
    lsofPath,
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf-8" },
  );
  return parseListeningPorts(stdout);
}

async function sendRequest(
  scheme: "http" | "https",
  port: number,
  path: string,
  csrfToken: string,
): Promise<unknown> {
  const payload = JSON.stringify(defaultBody());
  const transport = scheme === "https" ? https : http;

  return await new Promise<unknown>((resolve, reject) => {
    const req = transport.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: TIMEOUT_MS,
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? "unknown"}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("Invalid JSON response from Antigravity local API."));
          }
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("Antigravity request timed out.")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function queryLocalApi(
  ports: number[],
  csrfToken: string,
  path: string,
): Promise<unknown> {
  for (const port of ports) {
    try {
      return await sendRequest("https", port, path, csrfToken);
    } catch {
      try {
        return await sendRequest("http", port, path, csrfToken);
      } catch {
        // try next port
      }
    }
  }
  throw new Error("Could not connect to Antigravity local API ports.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseResetTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function modelFromConfig(raw: unknown): AntigravityModelQuota | null {
  const cfg = asRecord(raw);
  if (!cfg) return null;
  const quota = asRecord(cfg.quotaInfo);
  if (!quota) return null;

  const label = typeof cfg.label === "string" && cfg.label.trim() ? cfg.label.trim() : "Unknown model";
  const fraction =
    typeof quota.remainingFraction === "number"
      ? quota.remainingFraction
      : typeof quota.remainingFraction === "string"
        ? Number(quota.remainingFraction)
        : 0;
  const percentLeft = Math.max(0, Math.min(100, Math.round((Number.isFinite(fraction) ? fraction : 0) * 100)));
  const resetsIn = parseResetTime(quota.resetTime);
  return { label, percentLeft, resetsIn };
}

function parseUsage(raw: unknown): {
  email: string | null;
  plan: string | null;
  models: AntigravityModelQuota[];
} {
  const root = asRecord(raw);
  if (!root) throw new Error("Invalid API response.");

  let modelConfigs: unknown[] = [];
  let email: string | null = null;
  let plan: string | null = null;

  const userStatus = asRecord(root.userStatus);
  if (userStatus) {
    email = typeof userStatus.email === "string" ? userStatus.email : null;
    const planStatus = asRecord(userStatus.planStatus);
    const planInfo = asRecord(planStatus?.planInfo);
    const planCandidates = [
      planInfo?.planDisplayName,
      planInfo?.displayName,
      planInfo?.productName,
      planInfo?.planName,
    ];
    plan =
      (planCandidates.find((item) => typeof item === "string" && item.trim()) as string | undefined) ?? null;
    const cascade = asRecord(userStatus.cascadeModelConfigData);
    modelConfigs = asArray(cascade?.clientModelConfigs);
  }

  if (modelConfigs.length === 0) {
    modelConfigs = asArray(root.clientModelConfigs);
  }

  const models = modelConfigs.map(modelFromConfig).filter((model): model is AntigravityModelQuota => model !== null);
  if (models.length === 0) {
    throw new Error("No quota models available from local Antigravity API.");
  }

  const preferred = [...models].sort((a, b) => a.percentLeft - b.percentLeft).slice(0, 4);
  return { email, plan, models: preferred };
}

function formatOutput(data: { email: string | null; plan: string | null; models: AntigravityModelQuota[] }): string {
  const lines: string[] = [];
  lines.push(`Account      ${data.email ?? "unknown"}`);
  lines.push(`Plan         ${data.plan ?? "unknown"}`);
  lines.push("");
  for (const model of data.models) {
    lines.push(
      `${model.label.slice(0, 12).padEnd(12)} ${bar(model.percentLeft)} ${model.percentLeft}% remaining (${model.resetsIn})`,
    );
  }
  return lines.join("\n");
}

async function queryAntigravityUsage(): Promise<QueryResult> {
  try {
    const proc = await detectProcessInfo();
    const detectedPorts = await detectPorts(proc.pid);
    const orderedPorts = [proc.extensionPort, ...detectedPorts]
      .filter((port): port is number => typeof port === "number" && Number.isInteger(port))
      .filter((port, idx, list) => list.indexOf(port) === idx);

    if (orderedPorts.length === 0) {
      return {
        success: true,
        output: "Quota        skipped (no local Antigravity ports were detected)",
      };
    }

    let payload: unknown;
    try {
      payload = await queryLocalApi(orderedPorts, proc.csrfToken, USER_STATUS_PATH);
    } catch {
      payload = await queryLocalApi(orderedPorts, proc.csrfToken, MODEL_CONFIGS_PATH);
    }
    const parsed = parseUsage(payload);
    return { success: true, output: formatOutput(parsed) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/not running|csrf token|no local Antigravity ports/i.test(msg)) {
      return {
        success: true,
        output: `Quota        skipped (${msg})`,
      };
    }
    return {
      success: false,
      error: msg,
    };
  }
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  label: "Antigravity",
  query: queryAntigravityUsage,
};

