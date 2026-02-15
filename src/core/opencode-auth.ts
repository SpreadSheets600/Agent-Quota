import os from "node:os";
import path from "node:path";

export interface OpencodeAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  key?: string;
}

interface OpencodeAuthFile {
  [key: string]: OpencodeAuthEntry | undefined;
}

export function opencodeAuthPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

export function kiloAuthPath(): string {
  return path.join(os.homedir(), ".local", "share", "kilo", "auth.json");
}

export function knownAuthPaths(): string[] {
  return [opencodeAuthPath(), kiloAuthPath()];
}

export async function loadOpencodeAuth(): Promise<OpencodeAuthFile | null> {
  let merged: OpencodeAuthFile = {};

  for (const authPath of knownAuthPaths()) {
    const file = Bun.file(authPath);
    if (!(await file.exists())) {
      continue;
    }

    try {
      const parsed = (await file.json()) as OpencodeAuthFile;
      // Earlier paths win on key collisions.
      merged = { ...parsed, ...merged };
    } catch {
      // Ignore invalid auth file and continue.
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export async function loadOpencodeAuthEntry(name: string): Promise<OpencodeAuthEntry | null> {
  for (const authPath of knownAuthPaths()) {
    const file = Bun.file(authPath);
    if (!(await file.exists())) {
      continue;
    }

    try {
      const parsed = (await file.json()) as OpencodeAuthFile;
      const entry = parsed[name];
      if (entry) {
        return entry;
      }
    } catch {
      // Ignore invalid auth file and continue.
    }
  }

  return null;
}
