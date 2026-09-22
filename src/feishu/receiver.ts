import type {
  FeishuClient,
  FeishuInboundCallback,
  FeishuInboundMessage,
} from "./client.js";
import type { AttachmentStore } from "../messaging/attachments.js";
import type {
  InboundAttachment,
  SqliteTextInbox,
  TextInboxAppendSummary,
} from "../messaging/text-inbox.js";

const MAX_QUEUED_INBOUND = 100;

type ReceiverClient = Pick<
  FeishuClient,
  "startReceiving" | "isReceiving" | "close" | "downloadResource"
>;
type ReceiverInbox = Pick<SqliteTextInbox, "isActive" | "append">;
type ReceiverAttachments = Pick<AttachmentStore, "save">;

export type FeishuReceiverDiagnostics = {
  listener: "inactive" | "starting" | "listening" | "failed";
  lastListenerError: string | null;
  lastInboundAt: string | null;
  lastEnqueuedAt: string | null;
  lastInboundError: string | null;
};

function safeErrorCode(error: unknown, fallback: string): string {
  const code =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code)
    ? code
    : fallback;
}

/** Maintains one bounded Feishu listener and serializes authorized inbound work. */
export class FeishuReceiver {
  private listener: FeishuReceiverDiagnostics["listener"] = "inactive";
  private lastListenerError: string | null = null;
  private lastInboundAt: string | null = null;
  private lastEnqueuedAt: string | null = null;
  private lastInboundError: string | null = null;
  private queuedInbound = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private transitionTail: Promise<void> = Promise.resolve();
  private tickTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private closed = false;

  public constructor(
    private readonly client: ReceiverClient,
    private readonly inbox: ReceiverInbox,
    private readonly attachments: ReceiverAttachments,
  ) {}

  public tick(): Promise<void> {
    if (this.tickTask !== null) return this.tickTask;
    const operation = this.transitionTail.then(() => this.tickNow());
    const task = operation.finally(() => {
      if (this.tickTask === task) this.tickTask = null;
    });
    this.tickTask = task;
    this.transitionTail = task.catch(() => undefined);
    return task;
  }

  public async close(): Promise<void> {
    if (this.closeTask !== null) return this.closeTask;
    this.closed = true;
    const operation = this.transitionTail.then(async () => {
      this.client.close();
      this.listener = "inactive";
      await this.queueTail;
    });
    this.closeTask = operation;
    this.transitionTail = operation.catch(() => undefined);
    await operation;
  }

  public diagnostics(): FeishuReceiverDiagnostics {
    if (this.listener === "listening") {
      let receiving = false;
      try {
        receiving = this.client.isReceiving();
      } catch {
        receiving = false;
      }
      if (!receiving) {
        this.listener = "failed";
        this.lastListenerError = "FEISHU_CONNECTION_CLOSED";
      }
    }
    return {
      listener: this.listener,
      lastListenerError: this.lastListenerError,
      lastInboundAt: this.lastInboundAt,
      lastEnqueuedAt: this.lastEnqueuedAt,
      lastInboundError: this.lastInboundError,
    };
  }

  private async tickNow(): Promise<void> {
    if (this.closed) return;

    const inboxStatus = this.inboxStatus();
    const active = inboxStatus.active;
    if (!active) {
      let receiving = false;
      try {
        receiving = this.client.isReceiving();
      } catch {
        receiving = false;
      }
      if (receiving || this.listener !== "inactive") this.client.close();
      this.listener = "inactive";
      return;
    }

    let receiving = false;
    try {
      receiving = this.client.isReceiving();
    } catch {
      receiving = false;
    }
    if (!receiving && this.listener === "listening")
      this.lastListenerError = "FEISHU_CONNECTION_CLOSED";
    if (receiving) {
      this.listener = "listening";
      return;
    }

    this.listener = "starting";
    try {
      await this.client.startReceiving(this.receive);
      if (this.closed) {
        this.listener = "inactive";
      } else if (this.client.isReceiving()) {
        this.listener = "listening";
      } else {
        this.listener = "failed";
        this.lastListenerError = "FEISHU_CONNECTION_CLOSED";
      }
    } catch (error) {
      this.listener = "failed";
      this.lastListenerError = safeErrorCode(error, "LISTENER_START_FAILED");
    }
  }

  private readonly receive: FeishuInboundCallback = (message) => {
    this.lastInboundAt = new Date().toISOString();
    if (this.closed) {
      this.lastInboundError = "INBOX_INACTIVE";
      return Promise.resolve();
    }
    const inboxStatus = this.inboxStatus();
    if (!inboxStatus.active) {
      this.lastInboundError = inboxStatus.error ?? "INBOX_INACTIVE";
      return Promise.resolve();
    }
    if (this.queuedInbound >= MAX_QUEUED_INBOUND) {
      this.lastInboundError = "INBOUND_QUEUE_FULL";
      return Promise.resolve();
    }

    this.queuedInbound += 1;
    const operation = this.queueTail.then(() => this.process(message));
    this.queueTail = operation
      .catch(() => {
        this.lastInboundError = "INBOX_WRITE_FAILED";
      })
      .finally(() => {
        this.queuedInbound -= 1;
      });
    return operation.catch(() => undefined);
  };

  private async process(message: FeishuInboundMessage): Promise<void> {
    const initialInboxStatus = this.inboxStatus();
    if (!initialInboxStatus.active) {
      this.lastInboundError = initialInboxStatus.error ?? "INBOX_INACTIVE";
      return;
    }

    let text = message.text;
    const resources: InboundAttachment[] = [];
    for (const attachment of message.attachments.slice(0, 10)) {
      try {
        const path = await this.attachments.save(
          attachment.fileName,
          (destination) =>
            this.client.downloadResource(
              message.id,
              attachment.key,
              attachment.type,
              destination,
            ),
        );
        resources.push({
          type: attachment.type,
          path,
          fileName: attachment.fileName,
        });
      } catch {
        this.lastInboundError = "INBOUND_RESOURCE_FAILED";
        text += "\n[附件下载失败，请重新发送该附件。]";
      }
    }

    const finalInboxStatus = this.inboxStatus();
    if (!finalInboxStatus.active) {
      this.lastInboundError = finalInboxStatus.error ?? "INBOX_INACTIVE";
      return;
    }
    let summary: TextInboxAppendSummary;
    try {
      summary = this.inbox.append([
        {
          id: message.id,
          text,
          receivedAt: message.receivedAt,
          attachments: resources,
        },
      ]);
    } catch {
      this.lastInboundError = "INBOX_WRITE_FAILED";
      return;
    }
    if (summary.accepted > 0) this.lastEnqueuedAt = new Date().toISOString();
    if (summary.inactive > 0) this.lastInboundError = "INBOX_INACTIVE";
    else if (summary.rejected > 0)
      this.lastInboundError = "INBOX_INVALID_MESSAGE";
    else if (summary.expired > 0) this.lastInboundError = "INBOX_EXPIRED";
    else if (summary.overflow > 0) this.lastInboundError = "INBOX_OVERFLOW";
  }

  private inboxStatus(): { active: boolean; error: string | null } {
    try {
      return { active: this.inbox.isActive(), error: null };
    } catch {
      this.lastInboundError = "INBOX_READ_FAILED";
      return { active: false, error: "INBOX_READ_FAILED" };
    }
  }
}
