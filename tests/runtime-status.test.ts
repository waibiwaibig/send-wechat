import { describe, expect, it } from "vitest";

import { RuntimeApplication } from "../src/runtime/application.js";
import type {
  CredentialStore,
  RuntimeDependencies,
  StateStore,
} from "../src/runtime/ports.js";
import type { PersistedState, SecretBundle } from "../src/runtime/state.js";

class MemoryStateStore implements StateStore {
  public constructor(private state: PersistedState | null) {}

  async load(): Promise<PersistedState | null> {
    return this.state;
  }

  async save(state: PersistedState): Promise<void> {
    this.state = state;
  }

  async delete(): Promise<void> {
    this.state = null;
  }
}

class MemoryCredentialStore implements CredentialStore {
  public constructor(private secret: SecretBundle | null) {}

  async load(): Promise<SecretBundle | null> {
    return this.secret;
  }

  async save(secret: SecretBundle): Promise<void> {
    this.secret = secret;
  }

  async delete(): Promise<void> {
    this.secret = null;
  }

  async available(): Promise<boolean> {
    return true;
  }
}

function dependencies(params: {
  now: number;
  state: PersistedState | null;
  secret: SecretBundle | null;
}): RuntimeDependencies {
  return {
    clock: { now: () => params.now },
    stateStore: new MemoryStateStore(params.state),
    credentialStore: new MemoryCredentialStore(params.secret),
    idempotencyStore: {
      async find() {
        return null;
      },
      async insert() {},
      async update() {},
      async pruneBefore() {},
      async delete() {},
    },
    ilink: {
      async send() {
        throw new Error("send must not be called by status");
      },
    },
    audit: { async write() {} },
  };
}

const HOUR = 60 * 60 * 1000;

function boundState(lastInboundAt: number | null): PersistedState {
  return {
    schemaVersion: 1,
    binding: {
      botId: "bot-id",
      userId: "user-id",
      baseUrl: "https://ilinkai.weixin.qq.com",
      boundAt: "2026-08-24T00:00:00.000Z",
    },
    pollCursor: "",
    lastInboundAt,
    reminderAttemptedFor: null,
    authStale: false,
  };
}

const secret: SecretBundle = {
  schemaVersion: 1,
  botToken: "bot-token",
  contextToken: "context-token",
};

describe("runtime status interface", () => {
  it("reports the complete public session state machine", async () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");

    const cases = [
      {
        state: null,
        secret: null,
        expected: "not_logged_in",
      },
      {
        state: boundState(null),
        secret: { ...secret, contextToken: null },
        expected: "awaiting_message",
      },
      {
        state: boundState(now - 21 * HOUR),
        secret,
        expected: "ready",
      },
      {
        state: boundState(now - 23 * HOUR),
        secret,
        expected: "renewal_due",
      },
      {
        state: boundState(now - 24 * HOUR),
        secret,
        expected: "blocked",
      },
      {
        state: { ...boundState(now - HOUR), authStale: true },
        secret,
        expected: "auth_stale",
      },
    ] as const;

    for (const testCase of cases) {
      const app = new RuntimeApplication(
        dependencies({ now, state: testCase.state, secret: testCase.secret }),
      );
      const response = await app.execute({
        type: "status",
        requestId: "request-1",
      });

      expect(response).toMatchObject({
        ok: true,
        command: "status",
        requestId: "request-1",
        result: { state: testCase.expected },
      });
    }
  });
});
