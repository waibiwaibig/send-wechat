import { lstat } from "node:fs/promises";
import { basename } from "node:path";

import type { IpcClientPayload } from "../ipc/transport.js";
import { parsePairingInvitation } from "../relay/invitation.js";
import {
  type RecordValue,
  type SendOptions,
  type SetupOptions,
  failure,
  ensureNodeVersion,
  isRecord,
  normalizeFinal,
  safeCode,
} from "./contracts.js";
import { CliContext } from "./context.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

function optionIsPresent(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function normalizeSendOptions(options: SendOptions): {
  kind: "text" | "file" | "stdin";
  value: string;
} {
  const provided = [
    optionIsPresent(options.text),
    optionIsPresent(options.stdin),
    optionIsPresent(options.file),
  ].filter(Boolean).length;
  if (provided !== 1) failure("USAGE_ERROR", 2);
  if (options.text !== undefined) return { kind: "text", value: options.text };
  if (options.file !== undefined) return { kind: "file", value: options.file };
  return { kind: "stdin", value: "" };
}

async function validateFile(
  filePath: string,
): Promise<{ fileName: string; byteLength: number }> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      failure("FILE_NOT_FOUND", 2);
    failure("FILE_UNSAFE", 2);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    failure("FILE_UNSAFE", 2);
  if (metadata.size < 1 || metadata.size > MAX_FILE_BYTES)
    failure("INVALID_FILE_SIZE", 2);
  const fileName = basename(filePath);
  if (
    fileName.length === 0 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  )
    failure("INVALID_FILE_NAME", 2);
  if (Buffer.byteLength(fileName, "utf8") > 255)
    failure("INVALID_FILE_NAME", 2);
  return { fileName, byteLength: metadata.size };
}

function safeDaemonResult(command: string, result: unknown): RecordValue {
  return normalizeFinal(command, result);
}

async function runSend(
  context: CliContext,
  options: SendOptions,
): Promise<unknown> {
  const input = normalizeSendOptions(options);
  const idempotencyKey = options.idempotencyKey ?? context.randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
    failure("INVALID_IDEMPOTENCY_KEY", 2);
  let payload: IpcClientPayload;
  let filePath: string | undefined;
  if (input.kind === "file") {
    const metadata = await validateFile(input.value);
    filePath = input.value;
    payload = { command: "send_file", idempotencyKey, ...metadata };
  } else {
    const text =
      input.kind === "stdin" ? await context.readStdin() : input.value;
    const codePoints = Array.from(text).length;
    if (codePoints === 0 || codePoints > 4000) failure("INVALID_TEXT", 2);
    payload = { command: "send_text", idempotencyKey, text };
  }
  return safeDaemonResult("send", await context.dispatch(payload, filePath));
}

async function runDoctor(context: CliContext): Promise<unknown> {
  const checks: Record<
    string,
    { ok: boolean; code?: string; value?: unknown }
  > = {};
  let requestId: string | undefined;
  try {
    ensureNodeVersion(context.nodeVersion());
    checks.node = { ok: true, value: ">=24" };
  } catch {
    checks.node = { ok: false, code: "NODE_VERSION_UNSUPPORTED" };
  }
  try {
    checks.platform = { ok: true, value: context.getPlatform() };
  } catch (error) {
    checks.platform = {
      ok: false,
      code: safeCode((error as { code?: unknown }).code),
    };
  }
  try {
    const installation = await context.installation();
    if (installation?.role === "client") {
      checks.installation = { ok: true, value: "client" };
      try {
        const result = await context.dispatch({ command: "status" });
        const succeeded = isRecord(result) && result.ok === true;
        checks.relay = {
          ok: succeeded,
          ...(succeeded
            ? {}
            : {
                code: safeCode(
                  isRecord(result) && isRecord(result.error)
                    ? result.error.code
                    : "RELAY_CHECK_FAILED",
                ),
              }),
        };
        if (isRecord(result) && typeof result.requestId === "string")
          requestId = result.requestId;
      } catch (error) {
        checks.relay = {
          ok: false,
          code: safeCode((error as { code?: unknown }).code),
        };
      }
      const ok = Object.values(checks).every((check) => check.ok);
      return {
        schemaVersion: 1,
        ok,
        command: "doctor",
        ...(requestId === undefined ? {} : { requestId }),
        ...(ok
          ? {}
          : { error: { code: "DOCTOR_CHECK_FAILED", retryable: false } }),
        checks,
      };
    }
  } catch (error) {
    checks.installation = {
      ok: false,
      code: safeCode((error as { code?: unknown }).code),
    };
  }
  try {
    const status = await context.getServiceManager().status();
    const ready = status.installed === true && status.running === true;
    checks.service = {
      ok: ready,
      ...(ready ? {} : { code: "SERVICE_NOT_READY" }),
      value: {
        installed: status.installed === true,
        running: status.running === true,
      },
    };
  } catch (error) {
    checks.service = {
      ok: false,
      code: safeCode((error as { code?: unknown }).code),
    };
  }
  try {
    const capability = await context.capability();
    checks.capability = { ok: true };
    const result = await context.ipc(
      { command: "doctor" },
      undefined,
      undefined,
      undefined,
      capability,
    );
    if (isRecord(result) && typeof result.requestId === "string") {
      requestId = result.requestId;
    }
    if (isRecord(result) && isRecord(result.checks)) {
      addDaemonDoctorCheck(checks, "state", result.checks.state, [
        "absent",
        "valid",
      ]);
      addDaemonDoctorCheck(
        checks,
        "idempotencyLedger",
        result.checks.idempotencyLedger,
        ["valid"],
      );
      addDaemonDoctorCheck(
        checks,
        "credentialStore",
        result.checks.credentialStore,
        ["available"],
      );
      addDaemonDoctorCheck(checks, "protocol", result.checks.protocol, [
        "pinned",
      ]);
    }
    if (isRecord(result) && result.ok === false) {
      checks.daemon = {
        ok: false,
        code: safeCode(
          isRecord(result.error) ? result.error.code : "DAEMON_FAILURE",
        ),
      };
    } else {
      checks.daemon = { ok: true };
    }
  } catch (error) {
    checks.capability ??= {
      ok: false,
      code: safeCode((error as { code?: unknown }).code),
    };
    checks.daemon = {
      ok: false,
      code: safeCode((error as { code?: unknown }).code),
    };
  }
  const ok = Object.values(checks).every((check) => check.ok);
  return {
    schemaVersion: 1,
    ok,
    command: "doctor",
    ...(requestId === undefined ? {} : { requestId }),
    ...(ok ? {} : { error: { code: "DOCTOR_CHECK_FAILED", retryable: false } }),
    checks,
  };
}

function addDaemonDoctorCheck(
  checks: Record<string, { ok: boolean; code?: string; value?: unknown }>,
  name: string,
  value: unknown,
  acceptedValues: readonly string[],
): void {
  if (typeof value !== "string") {
    checks[name] = { ok: false, code: "DAEMON_CHECK_INVALID" };
    return;
  }
  checks[name] = {
    ok: acceptedValues.includes(value),
    value,
    ...(acceptedValues.includes(value) ? {} : { code: "DAEMON_CHECK_FAILED" }),
  };
}

async function runReset(context: CliContext): Promise<unknown> {
  const confirmation = await context.confirmReset();
  if (confirmation?.trim() !== "RESET")
    failure("RESET_CONFIRMATION_REQUIRED", 2);
  await context.deprovisionRelay();
  const installation = await context.installation();
  if (installation?.role !== "client") {
    const service = context.getServiceManager();
    const status = await service.status();
    if (status.running) await service.stop();
  }
  await context.reset();
  return { ok: true, command: "reset", result: { state: "stopped" } };
}

export async function runCommand(
  context: CliContext,
  command: string,
  options: RecordValue,
): Promise<unknown> {
  switch (command) {
    case "status":
      return safeDaemonResult(
        command,
        await context.dispatch({ command: "status" }),
      );
    case "setup": {
      const optionsWithPair = options as unknown as SetupOptions;
      if (
        (optionsWithPair.pair !== undefined &&
          optionsWithPair.pairStdin === true) ||
        (optionsWithPair.pairStdout === true &&
          (optionsWithPair.pair !== undefined ||
            optionsWithPair.pairStdin === true))
      )
        failure("USAGE_ERROR", 2);
      const pair =
        optionsWithPair.pairStdin === true
          ? (await context.readStdin()).trim()
          : optionsWithPair.pair;
      if (pair !== undefined) {
        try {
          parsePairingInvitation(pair);
        } catch {
          failure("PAIRING_INVITATION_INVALID", 2);
        }
      }
      const setupOptions: SetupOptions = {
        ...(pair === undefined ? {} : { pair }),
        ...(optionsWithPair.pairStdout === true ? { pairStdout: true } : {}),
        ...(optionsWithPair.qrFile === undefined
          ? {}
          : { qrFile: optionsWithPair.qrFile }),
      };
      const result = await context.setup(setupOptions);
      if (optionsWithPair.pairStdout === true) {
        if (
          !isRecord(result) ||
          result.ok !== true ||
          !isRecord(result.result) ||
          typeof result.result.invitation !== "string"
        )
          failure("PAIRING_INVITATION_INVALID", 2);
        return { ...result, pairStdout: true };
      }
      return safeDaemonResult(command, result);
    }
    case "send":
      return await runSend(context, options);
    case "doctor":
      return await runDoctor(context);
    case "reset":
      return await runReset(context);
    default:
      failure("USAGE_ERROR", 2);
  }
}

export function humanSuccess(
  command: string,
  result: unknown,
  language: "zh-CN" | "en",
): string {
  if (command === "doctor" && isRecord(result) && isRecord(result.checks)) {
    const labels: Record<string, { "zh-CN": string; en: string }> = {
      node: { "zh-CN": "Node", en: "Node" },
      platform: { "zh-CN": "平台", en: "Platform" },
      service: { "zh-CN": "服务", en: "Service" },
      capability: { "zh-CN": "能力文件", en: "Capability" },
      daemon: { "zh-CN": "daemon", en: "Daemon" },
      state: { "zh-CN": "状态文件", en: "State store" },
      idempotencyLedger: {
        "zh-CN": "幂等账本",
        en: "Idempotency ledger",
      },
      credentialStore: { "zh-CN": "凭据库", en: "Credential store" },
      protocol: { "zh-CN": "协议固定版本", en: "Protocol pin" },
      installation: { "zh-CN": "安装角色", en: "Installation role" },
      relay: { "zh-CN": "个人 Relay", en: "Personal relay" },
    };
    return (
      Object.entries(result.checks)
        .map(
          ([name, value]) =>
            `${labels[name]?.[language] ?? name}: ${isRecord(value) && value.ok === true ? "ok" : "failed"}`,
        )
        .join("\n") + "\n"
    );
  }
  if (command === "send") {
    const deduplicated =
      isRecord(result) &&
      isRecord(result.result) &&
      result.result.deduplicated === true;
    if (deduplicated) {
      return language === "zh-CN"
        ? "accepted（本地去重，未重发）\n"
        : "accepted (locally deduplicated; not resent)\n";
    }
    return "accepted\n";
  }
  if (command === "reset")
    return language === "zh-CN" ? "已完成 reset。\n" : "Reset completed.\n";
  if (command === "setup") {
    const details =
      isRecord(result) && isRecord(result.result) ? result.result : null;
    if (details !== null && details.role === "hub")
      return language === "zh-CN" ? "Hub 已就绪。\n" : "Hub is ready.\n";
    return language === "zh-CN"
      ? "设备已连接到个人 Relay。\n"
      : "This device is connected to the personal relay.\n";
  }
  if (command.startsWith("service"))
    return language === "zh-CN"
      ? "服务操作已完成。\n"
      : "Service operation completed.\n";
  if (command === "status" && isRecord(result) && isRecord(result.result))
    return language === "zh-CN"
      ? `状态：${String(result.result.state)}\n`
      : `State: ${String(result.result.state)}\n`;
  return `${language === "zh-CN" ? "完成" : "Done"}.\n`;
}
