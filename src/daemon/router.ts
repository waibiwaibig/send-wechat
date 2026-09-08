import type { RuntimeCommand } from "../runtime/application.js";
import type {
  LoginInteraction,
  LoginResult,
} from "../runtime/login-coordinator.js";
import type {
  IpcConnectionContext,
  IpcServerRequest,
} from "../ipc/transport.js";
import type { TextInboxPollResult } from "../messaging/text-inbox.js";

type RuntimeLike = {
  execute(command: RuntimeCommand): Promise<unknown>;
};

type LoginLike = {
  login(interaction: LoginInteraction): Promise<LoginResult>;
};

type TextInboxLike = {
  poll(consumerId: string): TextInboxPollResult;
  ack(consumerId: string, ids: string[]): void;
  release(consumerId: string): void;
};

export type DaemonRequestRouterDependencies = {
  runtime: RuntimeLike;
  login: LoginLike;
  doctor(): Promise<unknown>;
  issuePairingInvitation(): string;
  withPollingPaused<T>(operation: () => Promise<T>): Promise<T>;
  inbox?: TextInboxLike;
};

export class DaemonRequestRouter {
  private loginBarrier: Promise<void> = Promise.resolve();
  private readonly activeDeliveries = new Set<Promise<unknown>>();

  public constructor(
    private readonly dependencies: DaemonRequestRouterDependencies,
  ) {}

  public async handle(
    request: IpcServerRequest,
    context: IpcConnectionContext,
  ): Promise<unknown> {
    if (request.command === "login") return this.queueLogin(context);
    await this.loginBarrier;
    switch (request.command) {
      case "status":
        return this.dependencies.runtime.execute({
          type: "status",
          requestId: request.requestId,
        });
      case "send_text":
        return this.trackDelivery(
          this.dependencies.runtime.execute({
            type: "send-text",
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            text: request.text,
          }),
          request.requestId,
          request.idempotencyKey,
        );
      case "send_file":
        return this.trackDelivery(
          this.dependencies.runtime.execute({
            type: "send-file",
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            fileName: request.fileName,
            byteLength: request.byteLength,
            contentSha256: request.contentSha256,
            stagedPath: request.stagedPath,
          }),
          request.requestId,
          request.idempotencyKey,
        );
      case "doctor":
        return this.dependencies.doctor();
      case "pairing_invitation":
        return {
          ok: true,
          command: "setup",
          requestId: request.requestId,
          result: {
            invitation: this.dependencies.issuePairingInvitation(),
          },
        };
      case "inbox_poll":
        return this.handleInbox(() =>
          this.requireInbox().poll(request.consumerId),
        );
      case "inbox_ack":
        return this.handleInbox(() => {
          this.requireInbox().ack(request.consumerId, request.ids);
          return {};
        });
      case "inbox_release":
        return this.handleInbox(() => {
          this.requireInbox().release(request.consumerId);
          return {};
        });
      case "reset":
        return {
          ok: false,
          error: { code: "RESET_REQUIRES_STOPPED_DAEMON", retryable: false },
        };
    }
  }

  private requireInbox(): TextInboxLike {
    if (this.dependencies.inbox === undefined)
      throw new Error("INBOX_UNAVAILABLE");
    return this.dependencies.inbox;
  }

  private handleInbox(operation: () => unknown):
    | {
        ok: true;
        result: unknown;
      }
    | {
        ok: false;
        error: { code: string; retryable: boolean };
      } {
    try {
      return { ok: true, result: operation() };
    } catch (error) {
      const code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^INBOX_[A-Z_]+$/.test(error.code)
          ? error.code
          : "INBOX_UNAVAILABLE";
      return {
        ok: false,
        error: {
          code,
          retryable: code === "INBOX_BUSY",
        },
      };
    }
  }

  private queueLogin(context: IpcConnectionContext): Promise<LoginResult> {
    const result = this.loginBarrier.then(() =>
      this.dependencies.withPollingPaused(async () => {
        await Promise.allSettled([...this.activeDeliveries]);
        return this.dependencies.login.login({
          onQr: async (content) => context.emit({ type: "qr", content }),
          onState: async (state) =>
            context.emit({ type: "login_state", state }),
          requestVerifyCode: async () => context.requestVerifyCode(),
        });
      }),
    );
    this.loginBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async trackDelivery(
    delivery: Promise<unknown>,
    requestId: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    this.activeDeliveries.add(delivery);
    try {
      return await delivery;
    } catch {
      return {
        ok: false,
        command: "send",
        requestId,
        idempotencyKey,
        error: {
          code: "RESULT_UNKNOWN",
          message:
            "The send result is unknown and will not be retried automatically.",
          retryable: false,
        },
      };
    } finally {
      this.activeDeliveries.delete(delivery);
    }
  }
}
