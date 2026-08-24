import type { Writable } from "node:stream";

import { IpcTransportError } from "../ipc/transport.js";

import type { PlatformPaths, SupportedPlatform } from "../platform/paths.js";
import type {
  ServiceManager,
  ServiceManagerDependencies,
} from "../platform/service.js";
import type { RequestIpcOptions } from "../ipc/transport.js";
import type {
  loadCapability,
  loadOrCreateCapability,
} from "../ipc/capability.js";
import type { prepareOwnerDirectories } from "../platform/paths.js";
import type { resetOwnerData } from "../daemon/reset.js";
import type { CloudflareAccount } from "../relay/cloudflare.js";

export type CliIO = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: Writable;
  readonly stderr: Writable;
};

export type QrRenderer = {
  terminal(content: string): Promise<string> | string;
  png(path: string, content: string): Promise<void>;
};

export type CliDependencies = {
  readonly io?: CliIO;
  readonly requestIpc?: (options: RequestIpcOptions) => Promise<unknown>;
  readonly loadCapability?: typeof loadCapability;
  readonly loadOrCreateCapability?: typeof loadOrCreateCapability;
  readonly prepareOwnerDirectories?: typeof prepareOwnerDirectories;
  readonly paths?: PlatformPaths;
  readonly currentPlatformPaths?: () => PlatformPaths;
  readonly currentSupportedPlatform?: () => SupportedPlatform;
  readonly serviceManager?: ServiceManager;
  readonly createServiceManager?: (
    dependencies: ServiceManagerDependencies,
  ) => ServiceManager;
  readonly resetOwnerData?: typeof resetOwnerData;
  readonly reset?: (paths: PlatformPaths) => Promise<void>;
  readonly randomUUID?: () => string;
  readonly nodeVersion?: string;
  readonly cliEntry?: string;
  readonly runProductionDaemon?: () => Promise<void>;
  readonly promptVerifyCode?: () => Promise<string | null>;
  readonly promptReset?: () => Promise<string | null>;
  readonly promptCloudflareAccount?: (
    accounts: readonly CloudflareAccount[],
  ) => Promise<string>;
  readonly setup?: (
    options: SetupOptions,
    onEvent: (
      event: import("../ipc/transport.js").IpcEvent,
    ) => Promise<void> | void,
    onVerifyCode: () => Promise<string | null>,
    onAwaitingMessage: () => Promise<void>,
  ) => Promise<unknown>;
  readonly dispatch?: (
    payload: import("../ipc/transport.js").IpcClientPayload,
    filePath?: string,
  ) => Promise<unknown>;
  readonly deprovisionRelay?: () => Promise<void>;
  readonly qrRenderer?: QrRenderer;
  readonly renderQrTerminal?: (content: string) => Promise<string> | string;
  readonly writeQrPng?: (path: string, content: string) => Promise<void>;
};

export type GlobalOptions = { json?: boolean; lang?: "zh-CN" | "en" };
export type SendOptions = {
  text?: string;
  stdin?: boolean;
  file?: string;
  idempotencyKey?: string;
};
export type SetupOptions = { pair?: string; qrFile?: string };
export type RecordValue = Record<string, unknown>;

export class CliFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly exitCode: number,
  ) {
    super(code);
    this.name = "CliFailure";
  }
}

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeCode(value: unknown): string {
  if (typeof value !== "string") return "LOCAL_FAILURE";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "LOCAL_FAILURE";
}

export function codeFromError(error: unknown): string {
  if (error instanceof CliFailure) return error.code;
  if (error instanceof IpcTransportError) return safeCode(error.code);
  if (isRecord(error) && "code" in error) return safeCode(error.code);
  return "LOCAL_FAILURE";
}

export function classifyExitCode(code: string): number {
  if (
    code === "USAGE_ERROR" ||
    code === "INVALID_TEXT" ||
    code === "INVALID_FILE" ||
    code === "INVALID_FILE_SIZE" ||
    code === "INVALID_FILE_NAME" ||
    code === "FILE_NOT_FOUND" ||
    code === "FILE_UNSAFE" ||
    code === "FILE_CHANGED" ||
    code === "FILE_REQUIRED" ||
    code === "FILE_UNEXPECTED" ||
    code === "QR_FILE_EXISTS" ||
    code === "PAIRING_INVITATION_INVALID" ||
    code === "INVALID_IDEMPOTENCY_KEY" ||
    code === "RESET_CONFIRMATION_REQUIRED" ||
    code === "VERIFY_CODE_REQUIRED"
  )
    return 2;
  if (
    code === "SERVER_REJECTED" ||
    code === "PRE_SEND_FAILED" ||
    code === "RESULT_UNKNOWN" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "BUSY" ||
    code === "IPC_BUSY"
  )
    return 4;
  if (
    code === "IPC_UNAVAILABLE" ||
    code === "IPC_ENDPOINT_UNSAFE" ||
    code === "IPC_ALREADY_RUNNING" ||
    code === "IPC_UNAUTHORIZED" ||
    code === "IPC_FRAME_INVALID" ||
    code === "IPC_FRAME_TOO_LARGE" ||
    code === "IPC_TRUNCATED" ||
    code === "VERSION_MISMATCH" ||
    code === "CAPABILITY_NOT_INITIALIZED" ||
    code === "CAPABILITY_FILE_UNSAFE" ||
    code === "CAPABILITY_PERMISSIONS_UNSAFE" ||
    code === "CAPABILITY_FORMAT_INVALID" ||
    code === "NOT_LOGGED_IN" ||
    code === "AWAITING_MESSAGE" ||
    code === "AUTH_STALE" ||
    code === "SESSION_EXPIRED" ||
    code === "RESET_REQUIRES_STOPPED_DAEMON" ||
    code === "UNSUPPORTED_SERVICE" ||
    code === "SERVICE_NOT_READY" ||
    code === "CLIENT_HAS_NO_SERVICE" ||
    code === "PLATFORM_COMMAND_FAILED" ||
    code === "UNSUPPORTED_PLATFORM" ||
    code === "QR_CREATE_FAILED" ||
    code === "QR_PROTOCOL_FAILED" ||
    code === "QR_EXPIRED" ||
    code === "EXISTING_BINDING_UNAVAILABLE" ||
    code === "BINDING_MISMATCH" ||
    code === "LOGIN_CANCELLED" ||
    code === "QR_REDIRECT_INVALID" ||
    code === "LOGIN_TIMEOUT" ||
    code.startsWith("CREDENTIAL_") ||
    code.startsWith("CLOUDFLARE_") ||
    code.startsWith("INSTALLATION_") ||
    code.startsWith("PAIRING_") ||
    code.startsWith("RELAY_") ||
    code.startsWith("REMOTE_") ||
    code.startsWith("SETUP_") ||
    code.startsWith("STATE_") ||
    code.startsWith("LEDGER_")
  )
    return 3;
  if (code === "NODE_VERSION_UNSUPPORTED") return 3;
  return 5;
}

export function failure(
  code: string,
  exitCode = classifyExitCode(code),
): never {
  throw new CliFailure(safeCode(code), exitCode);
}

export function ensureNodeVersion(version: string): void {
  const match = /^(\d+)(?:\.|$)/.exec(version.trim());
  if (match === null || Number(match[1]) < 24)
    failure("NODE_VERSION_UNSUPPORTED");
}

export async function writeOutput(
  stream: Writable,
  value: string,
): Promise<void> {
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export function normalizeFinal(command: string, result: unknown): RecordValue {
  if (isRecord(result) && typeof result.ok === "boolean") {
    const body = { ...result };
    delete body.schemaVersion;
    const resultCommand =
      typeof body.command === "string" &&
      /^(?:setup|send|status|doctor|reset|service)$/.test(body.command)
        ? body.command
        : (command.split(" ")[0] ?? command);
    delete body.command;
    return {
      schemaVersion: 1,
      ok: body.ok,
      command: resultCommand,
      ...body,
    };
  }
  return { schemaVersion: 1, ok: true, command, result };
}

export function localizedMessage(
  code: string,
  language: "zh-CN" | "en",
): string {
  const messages: Record<string, { "zh-CN": string; en: string }> = {
    NODE_VERSION_UNSUPPORTED: {
      "zh-CN": "需要 Node.js 24 或更高版本。",
      en: "Node.js 24 or newer is required.",
    },
    USAGE_ERROR: { "zh-CN": "命令用法无效。", en: "Invalid command usage." },
    INVALID_TEXT: {
      "zh-CN": "文本必须包含 1 至 4000 个 Unicode 字符。",
      en: "Text must contain 1 to 4000 Unicode characters.",
    },
    INVALID_IDEMPOTENCY_KEY: {
      "zh-CN": "幂等键必须是 1 至 128 个安全 ASCII 字符。",
      en: "The idempotency key must contain 1 to 128 safe ASCII characters.",
    },
    IPC_UNAVAILABLE: {
      "zh-CN": "daemon 不可达。",
      en: "The daemon is unreachable.",
    },
    CAPABILITY_NOT_INITIALIZED: {
      "zh-CN": "daemon 尚未初始化。",
      en: "The daemon is not initialized.",
    },
    NOT_LOGGED_IN: { "zh-CN": "尚未登录。", en: "Weixin is not logged in." },
    AWAITING_MESSAGE: {
      "zh-CN": "等待绑定用户发消息以激活会话。",
      en: "A message from the bound user is required to activate the session.",
    },
    AUTH_STALE: {
      "zh-CN": "登录凭据已过期。",
      en: "The login credentials are stale.",
    },
    SESSION_EXPIRED: {
      "zh-CN": "blocked: 微信会话已过期，请先给 ClawBot 发一条消息。",
      en: "blocked: the Weixin session expired; send a message to ClawBot first.",
    },
    SERVER_REJECTED: {
      "zh-CN": "发送被 Weixin 拒绝。",
      en: "Weixin rejected the send request.",
    },
    PRE_SEND_FAILED: {
      "zh-CN": "请求在 sendmessage 开始前失败；未自动重试。",
      en: "The request failed before sendmessage began and was not retried.",
    },
    RESULT_UNKNOWN: {
      "zh-CN": "发送结果未知，未自动重试。",
      en: "The send result is unknown and was not retried.",
    },
    IDEMPOTENCY_CONFLICT: {
      "zh-CN": "幂等键已用于不同内容。",
      en: "The idempotency key was used for different content.",
    },
    BUSY: {
      "zh-CN": "发送队列已满，请稍后用同一个幂等键重试。",
      en: "The delivery queue is full; retry later with the same idempotency key.",
    },
    IPC_BUSY: {
      "zh-CN": "daemon 暂时无法接收更多文件，请稍后重试。",
      en: "The daemon cannot stage more files right now; retry later.",
    },
    RESET_CONFIRMATION_REQUIRED: {
      "zh-CN": "已取消 reset。",
      en: "Reset cancelled.",
    },
    FILE_NOT_FOUND: { "zh-CN": "文件不存在。", en: "The file does not exist." },
    FILE_UNSAFE: {
      "zh-CN": "文件必须是非符号链接的普通文件。",
      en: "The file must be a regular non-symlink file.",
    },
    INVALID_FILE_SIZE: {
      "zh-CN": "文件大小必须在 1 至 100 MiB 之间。",
      en: "The file must be between 1 and 100 MiB.",
    },
    INVALID_FILE_NAME: {
      "zh-CN": "文件名不受支持或不安全。",
      en: "The file name is unsupported or unsafe.",
    },
    QR_FILE_EXISTS: {
      "zh-CN": "二维码文件已存在；为避免覆盖，请换一个路径或先移动原文件。",
      en: "The QR file already exists; choose another path or move it first.",
    },
    PAIRING_INVITATION_INVALID: {
      "zh-CN": "配对邀请无效。",
      en: "The pairing invitation is invalid.",
    },
    PAIRING_INVITATION_EXPIRED: {
      "zh-CN": "配对邀请已过期，请在 Hub 重新运行 setup。",
      en: "The pairing invitation expired; run setup again on the Hub.",
    },
    PAIRING_INVITATION_USED: {
      "zh-CN": "配对邀请已被使用，请在 Hub 生成新邀请。",
      en: "The pairing invitation was already used; create a new one on the Hub.",
    },
    HUB_OFFLINE: {
      "zh-CN": "Hub 当前离线；Relay 没有排队该请求。",
      en: "The Hub is offline; the relay did not queue the request.",
    },
    CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED: {
      "zh-CN": "需要在交互终端选择 Cloudflare account。",
      en: "Select a Cloudflare account in an interactive terminal.",
    },
    CLOUDFLARE_KEYRING_UNAVAILABLE: {
      "zh-CN": "Cloudflare OAuth 无法使用系统钥匙串。",
      en: "Cloudflare OAuth could not use the operating-system keyring.",
    },
    INSTALLATION_INCONSISTENT: {
      "zh-CN": "本机角色与凭据不一致，已停止操作。",
      en: "The local role and credential are inconsistent; operation stopped.",
    },
    SETUP_INBOUND_TIMEOUT: {
      "zh-CN": "等待绑定用户的首条入站消息超时，请重新运行 setup。",
      en: "Timed out waiting for the binding user's first inbound message; run setup again.",
    },
    VERIFY_CODE_REQUIRED: {
      "zh-CN": "需要验证码。",
      en: "A verification code is required.",
    },
    BINDING_MISMATCH: {
      "zh-CN": "扫码用户与现有固定绑定不一致；如需重绑，请先执行 reset。",
      en: "The scanned user differs from the immutable binding; reset before rebinding.",
    },
    LOGIN_TIMEOUT: {
      "zh-CN": "登录等待超时，请重新运行 login。",
      en: "Login timed out; run login again.",
    },
    LOCAL_FAILURE: {
      "zh-CN": "本地操作失败。",
      en: "The local operation failed.",
    },
    DOCTOR_CHECK_FAILED: {
      "zh-CN": "一项或多项环境检查未通过。",
      en: "One or more environment checks failed.",
    },
    CLIENT_HAS_NO_SERVICE: {
      "zh-CN": "远端设备不运行本地后台服务。",
      en: "Remote clients do not run a local background service.",
    },
  };
  return (
    messages[code]?.[language] ??
    (language === "zh-CN"
      ? `操作失败（${code}）。`
      : `Operation failed (${code}).`)
  );
}
