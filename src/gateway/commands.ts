import type {
  CodexModel,
  ModelSelection,
  GatewayPermission,
} from "./codex-client.js";

export type GatewayCommand =
  | { type: "help" }
  | { type: "newchat" }
  | { type: "model"; args: string[] }
  | { type: "permission"; args: string[] }
  | { type: "stream"; args: string[] }
  | { type: "unknown"; name: string };

export function parseGatewayCommand(text: string): GatewayCommand | null {
  const value = text.trim().replace(/^／/u, "/");
  if (!value.startsWith("/")) return null;
  const [name = "", ...args] = value.split(/\s+/u);
  if ((name === "/" || name === "/help") && args.length === 0)
    return { type: "help" };
  if (name === "/newchat" && args.length === 0) return { type: "newchat" };
  if (name === "/model") return { type: "model", args };
  if (name === "/permission") return { type: "permission", args };
  if (name === "/stream") return { type: "stream", args };
  return { type: "unknown", name };
}

export const COMMAND_HELP = [
  "微信秘书命令（发送后生效）：",
  "/ 或 /help：查看命令",
  "/model：当前模型、可选模型与推理强度",
  "/model astra low：选择模型与推理强度",
  "/permission：查看和选择权限模式",
  "/stream：查看流式发送状态与开关用法",
  "/stream on：开启逐段发送，下一次回复生效",
  "/stream off：等每条完整回复生成后再发送，下一次回复生效",
  "/newchat：新建对话，保留模型、权限与流式选择",
  "微信输入框没有命令补全；请将命令单独发送。",
].join("\n");

export const PERMISSION_LABELS: Record<GatewayPermission, string> = {
  full: "完全访问",
  workspace: "工作区写入",
  "read-only": "只读",
};

export const STREAM_LABELS = {
  on: "开启",
  off: "关闭",
} as const;

export function streamMenu(streamEnabled: boolean): string {
  return [
    `当前流式发送：${streamEnabled ? STREAM_LABELS.on : STREAM_LABELS.off}`,
    "/stream on：开启逐段发送，下一次回复生效",
    "/stream off：等每条完整回复生成后再发送，下一次回复生效",
  ].join("\n");
}

export function permissionMenu(permission: GatewayPermission): string {
  return [
    `当前权限：${PERMISSION_LABELS[permission]}`,
    "/permission full：完全访问（默认），可读写本机文件并访问网络",
    "/permission workspace：可写工作目录，网络受 Codex 沙箱限制",
    "/permission read-only：只读，网络受 Codex 沙箱限制",
    "切换会停止当前回复，后续输入使用新权限。微信端不弹出审批窗口。",
  ].join("\n");
}

export function describeSelection(selection: ModelSelection): string {
  return `${selection.model} · ${selection.effort ?? "默认推理强度"}`;
}

export function modelMenu(
  selection: ModelSelection,
  models: readonly CodexModel[],
): string {
  return [
    `当前模型：${describeSelection(selection)}`,
    ...models.map(
      (model) =>
        `${model.model}：${model.supportedReasoningEfforts.join(" / ")}（默认 ${model.defaultReasoningEffort}）`,
    ),
    "发送 /model 模型名 推理强度，例如 /model astra low。",
    "支持目录中唯一的模型简称；省略推理强度时使用该模型默认值。",
  ].join("\n");
}

export function selectModel(
  args: readonly string[],
  models: readonly CodexModel[],
): { selection: ModelSelection } | { error: string } {
  if (args.length < 1 || args.length > 2)
    return { error: "用法：/model 模型名 [推理强度]。发送 /model 查看选项。" };
  const name = args[0]!.toLowerCase();
  const exact = models.filter((model) => model.model.toLowerCase() === name);
  const matches =
    exact.length > 0
      ? exact
      : models.filter(
          (model) => model.model.toLowerCase().split("-").at(-1) === name,
        );
  if (matches.length !== 1)
    return {
      error:
        matches.length > 1
          ? "模型简称对应多个选项，请发送 /model 查看并使用完整模型名。"
          : "未找到可选模型。发送 /model 查看当前 Codex 提供的选项。",
    };
  const model = matches[0]!;
  const effort = args[1]?.toLowerCase() ?? model.defaultReasoningEffort;
  if (!model.supportedReasoningEfforts.includes(effort))
    return {
      error: `${model.model} 支持：${model.supportedReasoningEfforts.join(" / ")}。`,
    };
  return { selection: { model: model.model, effort } };
}
