import os from "node:os";
import path from "node:path";
import { parseJwt } from "../utils/jwt";
import type { CodexAuthTokens } from "../types";
import { loadOpencodeAuthEntry } from "./opencode-auth";

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

function codexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export async function loadCodexTokens(): Promise<CodexAuthTokens> {
  const envAccess = process.env.OPENAI_ACCESS_TOKEN?.trim();
  const envAccount = process.env.OPENAI_ACCOUNT_ID?.trim() ?? null;

  if (envAccess) {
    const payload = parseJwt(envAccess);
    return {
      accessToken: envAccess,
      accountId: envAccount ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null,
      expiresAt: payload?.exp ? payload.exp * 1000 : null,
    };
  }

  const filePath = codexAuthPath();
  const file = Bun.file(filePath);

  if (await file.exists()) {
    const parsed = (await file.json()) as CodexAuthFile;
    const accessToken = parsed.tokens?.access_token?.trim();

    if (accessToken) {
      const payload = parseJwt(accessToken);
      return {
        accessToken,
        accountId:
          parsed.tokens?.account_id ??
          payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
          null,
        expiresAt: payload?.exp ? payload.exp * 1000 : null,
      };
    }
  }

  const opencodeOpenAI = await loadOpencodeAuthEntry("openai");
  if (opencodeOpenAI?.access) {
    const accessToken = opencodeOpenAI.access.trim();
    const payload = parseJwt(accessToken);
    return {
      accessToken,
      accountId:
        opencodeOpenAI.accountId ??
        payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
        null,
      expiresAt:
        typeof opencodeOpenAI.expires === "number"
          ? opencodeOpenAI.expires
          : payload?.exp
            ? payload.exp * 1000
            : null,
    };
  }

  throw new Error(`No OpenAI auth found in ${filePath} or ~/.local/share/opencode/auth.json`);
}
