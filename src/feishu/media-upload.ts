import { FeishuCliError, type FeishuCliRunner } from "./cli.js";

const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_FILE_NAME_LENGTH = 120;
const MAX_UPLOAD_CODE_LENGTH = 48;

export type FeishuMediaUploadPayload = {
  type: "image" | "file";
  fileName: string;
  cwd: string;
};

export type FeishuMediaUploadResult =
  { key: string } | { status: "failed"; code: string };

export async function uploadMedia(
  cli: Pick<FeishuCliRunner, "run">,
  payload: FeishuMediaUploadPayload,
): Promise<FeishuMediaUploadResult> {
  if (!isValidPayload(payload))
    return { status: "failed", code: "UPLOAD_INVALID_INPUT" };

  const isImage = payload.type === "image";
  const command = isImage ? "images" : "files";
  const data = isImage
    ? { image_type: "message" }
    : { file_type: "stream", file_name: payload.fileName };
  const field = isImage ? "image" : "file";
  try {
    const response = await cli.run(
      [
        "im",
        command,
        "create",
        "--data",
        JSON.stringify(data),
        "--file",
        `${field}=./${payload.fileName}`,
      ],
      { cwd: payload.cwd, timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    const key = keyFromResponse(response, payload.type);
    return key === null
      ? { status: "failed", code: "UPLOAD_MALFORMED_RESPONSE" }
      : { key };
  } catch (error) {
    return { status: "failed", code: uploadErrorCode(error) };
  }
}

function isValidPayload(
  payload: FeishuMediaUploadPayload,
): payload is FeishuMediaUploadPayload {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload.type === "image" || payload.type === "file") &&
    typeof payload.cwd === "string" &&
    payload.cwd.length > 0 &&
    typeof payload.fileName === "string" &&
    payload.fileName.trim().length > 0 &&
    payload.fileName.length <= MAX_FILE_NAME_LENGTH &&
    payload.fileName !== "." &&
    payload.fileName !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/.test(payload.fileName)
  );
}

function keyFromResponse(
  value: unknown,
  type: "image" | "file",
): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const key = (value as Record<string, unknown>)[
    type === "image" ? "image_key" : "file_key"
  ];
  const prefix = type === "image" ? "img_" : "file_";
  return typeof key === "string" &&
    new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(key)
    ? key
    : null;
}

function uploadErrorCode(error: unknown): string {
  const candidate =
    error instanceof FeishuCliError
      ? error.code
      : error !== null && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
  if (typeof candidate !== "string") return "UPLOAD_FAILED";
  const code = `UPLOAD_${candidate}`;
  return /^[A-Z][A-Z0-9_]*$/.test(candidate) &&
    code.length <= MAX_UPLOAD_CODE_LENGTH
    ? code
    : "UPLOAD_FAILED";
}
