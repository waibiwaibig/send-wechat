import type { QrStatus } from "../ilink/client.js";
import type { Clock, CredentialStore, StateStore } from "./ports.js";
import type { PersistedState, SecretBundle } from "./state.js";

const MAX_QR_REFRESHES = 3;
const MAX_POLL_ITERATIONS = 600;

export type LoginIlinkPort = {
  createQr(
    localBotTokens: readonly string[],
  ): Promise<{ qrcode: string; qrContent: string }>;
  pollQr(params: {
    qrcode: string;
    baseUrl: string;
    verifyCode?: string;
    signal?: AbortSignal;
  }): Promise<QrStatus>;
};

export type LoginCoordinatorDependencies = {
  stateStore: StateStore;
  credentialStore: CredentialStore;
  ilink: LoginIlinkPort;
  clock: Clock;
  sleep: (milliseconds: number) => Promise<void>;
};

export type LoginInteraction = {
  onQr(content: string): Promise<void>;
  onState(state: QrStatus["status"]): Promise<void>;
  requestVerifyCode(): Promise<string | null>;
  signal?: AbortSignal;
};

export type LoginResult =
  | { ok: true; state: "awaiting_message"; recovered: boolean }
  | { ok: false; error: { code: string; retryable: boolean } };

export class LoginCoordinator {
  public constructor(
    private readonly dependencies: LoginCoordinatorDependencies,
  ) {}

  public async login(interaction: LoginInteraction): Promise<LoginResult> {
    const [existingState, existingSecret] = await Promise.all([
      this.dependencies.stateStore.load(),
      this.dependencies.credentialStore.load(),
    ]);

    let currentQr: { qrcode: string; qrContent: string };
    try {
      currentQr = await this.dependencies.ilink.createQr(
        existingSecret === null ? [] : [existingSecret.botToken],
      );
    } catch {
      return failure("QR_CREATE_FAILED", true);
    }
    await interaction.onQr(currentQr.qrContent);

    let pollingBaseUrl = "https://ilinkai.weixin.qq.com";
    let verifyCode: string | undefined;
    let refreshes = 0;
    for (let iteration = 0; iteration < MAX_POLL_ITERATIONS; iteration += 1) {
      if (interaction.signal?.aborted) return failure("LOGIN_CANCELLED", true);
      let status: QrStatus;
      try {
        status = await this.dependencies.ilink.pollQr({
          qrcode: currentQr.qrcode,
          baseUrl: pollingBaseUrl,
          ...(verifyCode === undefined ? {} : { verifyCode }),
          ...(interaction.signal === undefined
            ? {}
            : { signal: interaction.signal }),
        });
      } catch {
        return failure("QR_PROTOCOL_FAILED", true);
      }
      await interaction.onState(status.status);

      if (status.status === "wait" || status.status === "scaned") {
        await this.dependencies.sleep(1000);
        continue;
      }
      if (status.status === "need_verifycode") {
        const provided = await interaction.requestVerifyCode();
        if (provided === null || !/^\d{4,8}$/.test(provided)) {
          return failure("VERIFY_CODE_REQUIRED", true);
        }
        verifyCode = provided;
        continue;
      }
      if (status.status === "scaned_but_redirect") {
        if (
          status.redirectHost === null ||
          !isSafeRedirectHost(status.redirectHost)
        ) {
          return failure("QR_REDIRECT_INVALID", false);
        }
        pollingBaseUrl = `https://${status.redirectHost}`;
        continue;
      }
      if (
        status.status === "expired" ||
        status.status === "verify_code_blocked"
      ) {
        refreshes += 1;
        if (refreshes >= MAX_QR_REFRESHES) return failure("QR_EXPIRED", true);
        verifyCode = undefined;
        try {
          currentQr = await this.dependencies.ilink.createQr(
            existingSecret === null ? [] : [existingSecret.botToken],
          );
        } catch {
          return failure("QR_CREATE_FAILED", true);
        }
        pollingBaseUrl = "https://ilinkai.weixin.qq.com";
        await interaction.onQr(currentQr.qrContent);
        continue;
      }
      if (status.status === "binded_redirect") {
        if (existingState === null || existingSecret === null) {
          return failure("EXISTING_BINDING_UNAVAILABLE", false);
        }
        const recoveredState: PersistedState = {
          ...existingState,
          pollCursor: "",
          lastInboundAt: null,
          reminderAttemptedFor: null,
          authStale: false,
        };
        const recoveredSecret: SecretBundle = {
          ...existingSecret,
          contextToken: null,
        };
        await this.dependencies.credentialStore.save(recoveredSecret);
        await this.dependencies.stateStore.save(recoveredState);
        return { ok: true, state: "awaiting_message", recovered: true };
      }
      if (status.status === "confirmed") {
        if (
          existingState !== null &&
          existingState.binding.userId !== status.userId
        ) {
          return failure("BINDING_MISMATCH", false);
        }
        const state: PersistedState = {
          schemaVersion: 1,
          binding: {
            botId: status.botId,
            userId: status.userId,
            baseUrl: status.baseUrl,
            boundAt:
              existingState?.binding.boundAt ??
              new Date(this.dependencies.clock.now()).toISOString(),
          },
          pollCursor: "",
          lastInboundAt: null,
          reminderAttemptedFor: null,
          authStale: true,
        };
        const secret: SecretBundle = {
          schemaVersion: 1,
          botToken: status.botToken,
          contextToken: null,
        };
        await this.dependencies.stateStore.save(state);
        await this.dependencies.credentialStore.save(secret);
        state.authStale = false;
        await this.dependencies.stateStore.save(state);
        return {
          ok: true,
          state: "awaiting_message",
          recovered: existingState !== null,
        };
      }
    }

    return failure("LOGIN_TIMEOUT", true);
  }
}

function failure(code: string, retryable: boolean): LoginResult {
  return { ok: false, error: { code, retryable } };
}

function isSafeRedirectHost(value: string): boolean {
  if (
    !/^[A-Za-z0-9.-]{1,253}$/.test(value) ||
    value.startsWith(".") ||
    value.endsWith(".")
  ) {
    return false;
  }
  try {
    const parsed = new URL(`https://${value}`);
    return parsed.hostname === value.toLowerCase() && parsed.port === "";
  } catch {
    return false;
  }
}
