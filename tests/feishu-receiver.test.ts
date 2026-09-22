import { expect, it, vi } from "vitest";

import { FeishuReceiver } from "../src/feishu/receiver.js";
import type {
  FeishuInboundCallback,
  FeishuInboundMessage,
} from "../src/feishu/client.js";
import type { TextInboxAppendSummary } from "../src/messaging/text-inbox.js";

const accepted: TextInboxAppendSummary = {
  accepted: 1,
  rejected: 0,
  duplicates: 0,
  expired: 0,
  overflow: 0,
  inactive: 0,
};

function message(
  overrides: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage {
  return {
    id: "om_message",
    text: "hello",
    receivedAt: Date.parse("2026-09-22T00:00:00.000Z"),
    attachments: [],
    ...overrides,
  };
}

function harness() {
  let callback: FeishuInboundCallback | undefined;
  const isReceiving = vi.fn(() => false);
  const client = {
    startReceiving: vi.fn(async (next: FeishuInboundCallback) => {
      callback = next;
      isReceiving.mockReturnValue(true);
    }),
    isReceiving,
    close: vi.fn(),
    downloadResource: vi.fn(async () => undefined),
  };
  const inbox = {
    active: true,
    isActive: vi.fn(() => inbox.active),
    append: vi.fn(() => accepted),
  };
  const attachments = {
    save: vi.fn(
      async (
        _fileName: string,
        download: (destination: string) => Promise<void>,
      ) => {
        await download("/private/attachment.bin");
        return "/private/attachment.bin";
      },
    ),
  };
  const receiver = new FeishuReceiver(client, inbox, attachments);
  return {
    client,
    inbox,
    attachments,
    receiver,
    get callback() {
      return callback;
    },
  };
}

it("starts only for an active inbox and restarts a dead listener", async () => {
  const app = harness();
  app.inbox.active = false;
  await app.receiver.tick();
  expect(app.client.startReceiving).not.toHaveBeenCalled();
  app.inbox.active = true;
  await app.receiver.tick();
  expect(app.client.startReceiving).toHaveBeenCalledTimes(1);
  app.client.isReceiving.mockReturnValue(false);
  await app.receiver.tick();
  expect(app.client.startReceiving).toHaveBeenCalledTimes(2);
  app.client.isReceiving.mockReturnValue(false);
  expect(app.receiver.diagnostics()).toMatchObject({
    listener: "failed",
    lastListenerError: "FEISHU_CONNECTION_CLOSED",
  });
});

it("coalesces concurrent slow ticks into one startup operation", async () => {
  const app = harness();
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.client.startReceiving.mockImplementationOnce(async () => {
    await started;
  });
  const first = app.receiver.tick();
  const second = app.receiver.tick();
  expect(second).toBe(first);
  release();
  await first;
  expect(app.client.startReceiving).toHaveBeenCalledTimes(1);
});

it("marks a listener failed when startup resolves after the subscription is already closed", async () => {
  const app = harness();
  app.client.startReceiving.mockImplementationOnce(async () => {
    app.client.isReceiving.mockReturnValue(false);
  });
  await app.receiver.tick();
  expect(app.receiver.diagnostics()).toMatchObject({
    listener: "failed",
    lastListenerError: "FEISHU_CONNECTION_CLOSED",
  });
});

it("stops on an inactive inbox and preserves a safe startup error", async () => {
  const app = harness();
  await app.receiver.tick();
  app.inbox.active = false;
  await app.receiver.tick();
  expect(app.client.close).toHaveBeenCalledTimes(1);
  expect(app.receiver.diagnostics()).toMatchObject({ listener: "inactive" });

  app.inbox.active = true;
  app.client.isReceiving.mockReturnValue(false);
  app.client.startReceiving.mockRejectedValueOnce(
    Object.assign(new Error("private upstream response"), {
      code: "FEISHU_CONNECTION_CLOSED",
    }),
  );
  await app.receiver.tick();
  expect(app.receiver.diagnostics()).toMatchObject({
    listener: "failed",
    lastListenerError: "FEISHU_CONNECTION_CLOSED",
  });
});

it("enqueues authorized messages, saves media, and exposes only observation times", async () => {
  const app = harness();
  await app.receiver.tick();
  await app.callback?.(
    message({
      attachments: [{ type: "file", key: "resource-key", fileName: "note.md" }],
    }),
  );
  const diagnostics = app.receiver.diagnostics();
  expect(app.attachments.save).toHaveBeenCalledWith(
    "note.md",
    expect.any(Function),
  );
  expect(app.client.downloadResource).toHaveBeenCalledWith(
    "om_message",
    "resource-key",
    "file",
    "/private/attachment.bin",
  );
  expect(app.inbox.append).toHaveBeenCalledWith([
    expect.objectContaining({
      id: "om_message",
      text: "hello",
      attachments: [
        { type: "file", path: "/private/attachment.bin", fileName: "note.md" },
      ],
    }),
  ]);
  expect(diagnostics.listener).toBe("listening");
  expect(diagnostics.lastInboundAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(diagnostics.lastEnqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.stringify(diagnostics)).not.toContain("om_message");
  expect(JSON.stringify(diagnostics)).not.toContain("resource-key");
  expect(JSON.stringify(diagnostics)).not.toContain("attachment.bin");
});

it("records media and inbox failures without exposing their messages", async () => {
  const app = harness();
  await app.receiver.tick();
  app.attachments.save.mockRejectedValueOnce(new Error("secret download body"));
  await app.callback?.(
    message({
      attachments: [{ type: "file", key: "secret-key", fileName: "secret.md" }],
    }),
  );
  expect(app.receiver.diagnostics().lastInboundError).toBe(
    "INBOUND_RESOURCE_FAILED",
  );

  app.inbox.append.mockReturnValueOnce({
    accepted: 0,
    rejected: 1,
    duplicates: 0,
    expired: 0,
    overflow: 0,
    inactive: 0,
  });
  await app.callback?.(message({ id: "om_invalid" }));
  const diagnostics = app.receiver.diagnostics();
  expect(diagnostics.lastInboundError).toBe("INBOX_INVALID_MESSAGE");
  expect(JSON.stringify(diagnostics)).not.toContain("secret");
  expect(JSON.stringify(diagnostics)).not.toContain("om_invalid");
});

it("bounds the serialized inbound queue and drains it on close", async () => {
  const app = harness();
  await app.receiver.tick();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.attachments.save.mockImplementationOnce(async () => {
    await blocked;
    return "/private/attachment.bin";
  });
  const callbacks = [
    app.callback?.(
      message({
        id: "om_blocked",
        attachments: [{ type: "file", key: "key", fileName: "file" }],
      }),
    ),
    ...Array.from({ length: 100 }, (_, index) =>
      app.callback?.(message({ id: `om_${index}` })),
    ),
  ];
  expect(app.receiver.diagnostics().lastInboundError).toBe(
    "INBOUND_QUEUE_FULL",
  );
  const closing = app.receiver.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await Promise.all(callbacks);
  await closing;
  expect(app.client.close).toHaveBeenCalledTimes(1);
  expect(app.inbox.append).toHaveBeenCalledTimes(100);
});

it("records an inactive inbox callback and never appends it", async () => {
  const app = harness();
  await app.receiver.tick();
  app.inbox.active = false;
  await app.callback?.(message());
  expect(app.inbox.append).not.toHaveBeenCalled();
  expect(app.receiver.diagnostics().lastInboundError).toBe("INBOX_INACTIVE");
});

it("records inbox read failures without exposing the thrown message", async () => {
  const app = harness();
  await app.receiver.tick();
  app.inbox.isActive.mockImplementationOnce(() => {
    throw new Error("private sqlite path");
  });
  await app.callback?.(message());
  expect(app.receiver.diagnostics().lastInboundError).toBe("INBOX_READ_FAILED");
  expect(app.inbox.append).not.toHaveBeenCalled();
});
