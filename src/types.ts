export interface QuerySuccess {
  success: true;
  output: string;
}

export interface QueryFailure {
  success: false;
  error: string;
}

export type QueryResult = QuerySuccess | QueryFailure;

export interface CodexAuthTokens {
  accessToken: string;
  accountId: string | null;
  expiresAt: number | null;
}

export interface Provider {
  id: string;
  label: string;
  query: () => Promise<QueryResult>;
}

export interface AppState {
  lastUpdated: Date | null;
  status: "idle" | "loading" | "ok" | "error";
  content: string;
  message: string;
}
