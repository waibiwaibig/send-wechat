import { renameFile } from "../platform/atomic-rename.js";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { NotificationChannel } from "./hook.js";

const HOOK_MARKER = "send-message-notification-hook:v1";
const QUESTION_MATCHER = String.raw`^(functions\.)?request_user_input(_async)?$`;

export type NotificationInstallOptions = {
  codexHome: string;
  channel?: NotificationChannel;
  enabled: boolean;
  cliEntry: string;
  nodeExecutable: string;
};

export type NotificationInstallResult = {
  hooksPath: string;
  enabled: boolean;
  trustMessage: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function ownCommand(value: JsonObject): boolean {
  return (
    (typeof value.command === "string" &&
      value.command.includes(HOOK_MARKER)) ||
    (typeof value.commandWindows === "string" &&
      value.commandWindows.includes(HOOK_MARKER))
  );
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function notificationArguments(options: NotificationInstallOptions): string[] {
  const channel =
    options.channel === undefined ? [] : ["--channel", options.channel];
  return [
    options.cliEntry,
    "internal-notification-hook",
    "--owner-marker",
    HOOK_MARKER,
    ...channel,
  ];
}

function notificationCommands(options: NotificationInstallOptions): {
  command: string;
  commandWindows: string;
} {
  const args = notificationArguments(options);
  const command = [
    shellQuote(options.nodeExecutable),
    ...args.map(shellQuote),
  ].join(" ");
  const powershell = [
    "&",
    powerShellQuote(options.nodeExecutable),
    ...args.map(powerShellQuote),
  ].join(" ");
  const commandWindows = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
    powershell,
    "utf16le",
  ).toString("base64")}`;
  return { command, commandWindows };
}

function removeOwnedEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const result: unknown[] = [];
  for (const entry of value) {
    if (!isObject(entry)) {
      result.push(entry);
      continue;
    }
    const children = entry.hooks;
    if (!Array.isArray(children)) {
      if (!ownCommand(entry)) result.push(entry);
      continue;
    }
    const keptChildren = children.filter(
      (child) => !isObject(child) || !ownCommand(child),
    );
    if (keptChildren.length > 0) result.push({ ...entry, hooks: keptChildren });
  }
  return result;
}

function ownHookGroup(
  commands: { command: string; commandWindows: string },
  matcher?: string,
): JsonObject {
  const hook: JsonObject = {
    type: "command",
    command: commands.command,
    commandWindows: commands.commandWindows,
    async: true,
    timeout: 30,
  };
  const group: JsonObject = { hooks: [hook] };
  if (matcher !== undefined) group.matcher = matcher;
  return group;
}

function mergeHooks(
  document: JsonObject,
  options: NotificationInstallOptions,
): JsonObject {
  const hooksValue = isObject(document.hooks) ? document.hooks : {};
  const hooks: JsonObject = { ...hooksValue };
  const commands = notificationCommands(options);
  for (const eventName of ["Stop", "PreToolUse"]) {
    const existing = removeOwnedEntries(hooks[eventName]);
    if (options.enabled) {
      existing.push(
        eventName === "Stop"
          ? ownHookGroup(commands)
          : ownHookGroup(commands, QUESTION_MATCHER),
      );
    }
    hooks[eventName] = existing;
  }
  return { ...document, hooks };
}

async function readDocument(path: string): Promise<JsonObject> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("HOOKS_FILE_UNSAFE");
    const content = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(content)) throw new Error("HOOKS_JSON_INVALID");
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("HOOKS_DIRECTORY_UNSAFE");
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFile(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function configureNotifications(
  options: NotificationInstallOptions,
): Promise<NotificationInstallResult> {
  if (
    !isObject(options) ||
    typeof options.codexHome !== "string" ||
    typeof options.cliEntry !== "string" ||
    typeof options.nodeExecutable !== "string" ||
    typeof options.enabled !== "boolean" ||
    options.codexHome.length === 0 ||
    options.cliEntry.length === 0 ||
    options.nodeExecutable.length === 0
  ) {
    throw new Error("INVALID_NOTIFICATION_OPTIONS");
  }
  if (
    options.channel !== undefined &&
    !new Set<NotificationChannel>(["wechat", "feishu", "both"]).has(
      options.channel,
    )
  ) {
    throw new Error("INVALID_NOTIFICATION_CHANNEL");
  }
  const hooksPath = join(options.codexHome, "hooks.json");
  const existing = await readDocument(hooksPath);
  const merged = mergeHooks(existing, options);
  await atomicWrite(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    hooksPath,
    enabled: options.enabled,
    trustMessage: options.enabled
      ? `请在 Codex 设置中信任新 hook：${HOOK_MARKER}。本安装不会自动写入 trusted hashes。`
      : "通知 hook 已禁用；其他 hooks 保持不变。",
  };
}

export const NOTIFICATION_HOOK_MARKER = HOOK_MARKER;
