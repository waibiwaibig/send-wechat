export const STATE_SCHEMA_VERSION = 1 as const;

export type Binding = {
  botId: string;
  userId: string;
  baseUrl: string;
  boundAt: string;
};

export type IdempotencyStatus = "pending" | "accepted" | "rejected" | "unknown";

export type IdempotencyEntry = {
  key: string;
  payloadType: "text" | "file" | "reminder";
  payloadHash: string;
  status: IdempotencyStatus;
  createdAt: number;
  resultCode: string;
  clientMessageId: string | null;
};

export type PersistedState = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  binding: Binding;
  pollCursor: string;
  lastInboundAt: number | null;
  reminderAttemptedFor: number | null;
  authStale: boolean;
};

export type SecretBundle = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  botToken: string;
  contextToken: string | null;
};
