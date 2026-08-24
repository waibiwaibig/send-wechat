import type {
  IdempotencyEntry,
  PersistedState,
  SecretBundle,
} from "./state.js";

export type Clock = {
  now(): number;
};

export type StateStore = {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
  delete(): Promise<void>;
};

export type CredentialStore = {
  load(): Promise<SecretBundle | null>;
  save(secret: SecretBundle): Promise<void>;
  delete(): Promise<void>;
  available(): Promise<boolean>;
};

export type IdempotencyStore = {
  find(key: string): Promise<IdempotencyEntry | null>;
  insert(entry: IdempotencyEntry): Promise<void>;
  update(entry: IdempotencyEntry): Promise<void>;
  pruneBefore(cutoff: number): Promise<void>;
  delete(): Promise<void>;
};

export type IlinkSendRequest = {
  binding: PersistedState["binding"];
  secret: SecretBundle;
  payload:
    | { type: "text"; text: string }
    | {
        type: "file";
        stagedPath: string;
        fileName: string;
        byteLength: number;
      };
  clientId: string;
};

export type IlinkPort = {
  send(
    request: IlinkSendRequest,
  ): Promise<
    | { status: "accepted"; clientMessageId: string }
    | { status: "rejected"; code: string }
    | { status: "failed"; code: string }
    | { status: "unknown"; code: string }
  >;
};

export type AuditEvent = {
  timestamp: string;
  requestId: string | null;
  event: string;
  payloadType: "text" | "file" | "reminder" | null;
  byteSize: number | null;
  latencyMs: number | null;
  resultCode: string | null;
};

export type AuditPort = {
  write(event: AuditEvent): Promise<void>;
};

export type RuntimeDependencies = {
  clock: Clock;
  stateStore: StateStore;
  credentialStore: CredentialStore;
  idempotencyStore: IdempotencyStore;
  ilink: IlinkPort;
  audit: AuditPort;
};
