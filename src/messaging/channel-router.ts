import type {
  RuntimeCommand,
  RuntimeResponse,
} from "../runtime/application.js";

export type Channel = "wechat" | "feishu";
export type ChannelSelection = Channel | "both";

export interface ChannelRuntime {
  execute(command: RuntimeCommand): Promise<RuntimeResponse>;
}

type RoutedCommand = RuntimeCommand & { channel?: ChannelSelection };

type ChannelFailure = {
  ok: false;
  command: "status" | "send";
  requestId: string;
  idempotencyKey?: string;
  error: {
    code: string;
    message: string;
    retryable: false;
  };
};

type StatusChannelValue =
  | Extract<RuntimeResponse, { ok: true; command: "status" }>["result"]
  | RuntimeResponse
  | ChannelFailure;

export type ChannelStatusResult = {
  defaultChannel: Channel;
  channels: Partial<Record<Channel, StatusChannelValue>>;
};

export type ChannelSendResult = {
  state: "accepted" | "partial" | "failed";
  channels: Partial<Record<Channel, RuntimeResponse | ChannelFailure>>;
};

export type ChannelRouterResponse =
  | {
      ok: true;
      command: "status";
      requestId: string;
      result: ChannelStatusResult;
    }
  | {
      ok: false;
      command: "status";
      requestId: string;
      result: ChannelStatusResult;
      error: {
        code: "CHANNEL_SEND_FAILED";
        retryable: false;
      };
    }
  | {
      ok: true;
      command: "send";
      requestId: string;
      result: ChannelSendResult & { state: "accepted" };
    }
  | {
      ok: false;
      command: "send";
      requestId: string;
      result: ChannelSendResult & { state: "partial" | "failed" };
      error: {
        code: "CHANNEL_SEND_FAILED";
        retryable: false;
      };
    };

export class ChannelRouter {
  public constructor(
    private readonly options: {
      defaultChannel: Channel;
      providers: Partial<Record<Channel, ChannelRuntime>>;
    },
  ) {}

  public async execute(command: RoutedCommand): Promise<ChannelRouterResponse> {
    const { channel: selection, ...runtimeCommand } = command;

    if (runtimeCommand.type === "status")
      return this.executeStatus(runtimeCommand);

    const channels = this.channelsForSend(selection);
    const results = await Promise.all(
      channels.map(
        async (channel) =>
          [
            channel,
            await this.executeChannel(channel, runtimeCommand),
          ] as const,
      ),
    );
    const channelResults = Object.fromEntries(results) as Partial<
      Record<Channel, RuntimeResponse | ChannelFailure>
    >;
    const values = results.map(([, result]) => result);
    const successful = values.every((result) => result.ok);
    const state = successful
      ? "accepted"
      : values.some((result) => result.ok)
        ? "partial"
        : "failed";
    const result = { state, channels: channelResults };

    if (successful) {
      return {
        ok: true,
        command: "send",
        requestId: runtimeCommand.requestId,
        result: result as ChannelSendResult & { state: "accepted" },
      };
    }
    return {
      ok: false,
      command: "send",
      requestId: runtimeCommand.requestId,
      result: result as ChannelSendResult & { state: "partial" | "failed" },
      error: { code: "CHANNEL_SEND_FAILED", retryable: false },
    };
  }

  private async executeStatus(
    command: Extract<RuntimeCommand, { type: "status" }>,
  ): Promise<ChannelRouterResponse> {
    const channels = (Object.keys(this.options.providers) as Channel[]).filter(
      (channel) => this.options.providers[channel] !== undefined,
    );
    const results = await Promise.all(
      channels.map(
        async (channel) =>
          [channel, await this.executeChannel(channel, command)] as const,
      ),
    );
    const channelResults: Partial<Record<Channel, StatusChannelValue>> = {};
    let successful = true;
    for (const [channel, response] of results) {
      if (response.ok && response.command === "status")
        channelResults[channel] = response.result;
      else {
        successful = false;
        channelResults[channel] = response;
      }
    }
    const result: ChannelStatusResult = {
      defaultChannel: this.options.defaultChannel,
      channels: channelResults,
    };
    if (successful) {
      return {
        ok: true,
        command: "status",
        requestId: command.requestId,
        result,
      };
    }
    return {
      ok: false,
      command: "status",
      requestId: command.requestId,
      result,
      error: { code: "CHANNEL_SEND_FAILED", retryable: false },
    };
  }

  private channelsForSend(selection: ChannelSelection | undefined): Channel[] {
    if (selection === "both") return ["wechat", "feishu"];
    return [selection ?? this.options.defaultChannel];
  }

  private async executeChannel(
    channel: Channel,
    command: RuntimeCommand,
  ): Promise<RuntimeResponse | ChannelFailure> {
    const provider = this.options.providers[channel];
    if (provider === undefined) {
      return {
        ok: false,
        command: command.type === "status" ? "status" : "send",
        requestId: command.requestId,
        ...(command.type === "status"
          ? {}
          : { idempotencyKey: command.idempotencyKey }),
        error: {
          code: "CHANNEL_NOT_CONFIGURED",
          message: `The ${channel} channel is not configured.`,
          retryable: false,
        },
      };
    }
    try {
      return await provider.execute(command);
    } catch {
      return {
        ok: false,
        command: command.type === "status" ? "status" : "send",
        requestId: command.requestId,
        ...(command.type === "status"
          ? {}
          : { idempotencyKey: command.idempotencyKey }),
        error: {
          code: "RESULT_UNKNOWN",
          message:
            "The channel result is unknown and will not be retried automatically.",
          retryable: false,
        },
      };
    }
  }
}
