import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FeishuCliError, type FeishuCliRunner } from "../src/feishu/cli.js";
import { uploadMedia } from "../src/feishu/media-upload.js";

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 120_000;

function binaryPath(): string {
  const packageJson = require.resolve("@larksuite/cli/package.json");
  return join(
    dirname(packageJson),
    "bin",
    `lark-cli${process.platform === "win32" ? ".exe" : ""}`,
  );
}

function runner(
  result: unknown = { file_key: "file_abc-123" },
): Pick<FeishuCliRunner, "run"> & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockResolvedValue(result),
  };
}

describe("Feishu media upload", () => {
  it("keeps the pinned file upload contract and preserves a markdown filename", async () => {
    const cli = runner({ file_key: "file_abc-123" });

    await expect(
      uploadMedia(cli, {
        type: "file",
        fileName: "notes.md",
        cwd: "/tmp/feishu-stage",
      }),
    ).resolves.toEqual({ key: "file_abc-123" });
    expect(cli.run).toHaveBeenCalledTimes(1);
    expect(cli.run).toHaveBeenCalledWith(
      [
        "im",
        "files",
        "create",
        "--data",
        JSON.stringify({ file_type: "stream", file_name: "notes.md" }),
        "--file",
        "file=./notes.md",
      ],
      { cwd: "/tmp/feishu-stage", timeoutMs: TIMEOUT_MS },
    );
  });

  it("uses the image form field and returns the image key", async () => {
    const cli = runner({ image_key: "img_abc-123" });

    await expect(
      uploadMedia(cli, {
        type: "image",
        fileName: "photo.png",
        cwd: "/tmp/feishu-stage",
      }),
    ).resolves.toEqual({ key: "img_abc-123" });
    expect(cli.run).toHaveBeenCalledWith(
      [
        "im",
        "images",
        "create",
        "--data",
        JSON.stringify({ image_type: "message" }),
        "--file",
        "image=./photo.png",
      ],
      { cwd: "/tmp/feishu-stage", timeoutMs: TIMEOUT_MS },
    );
  });

  it("rejects malformed or unsafe keys without retrying", async () => {
    for (const response of [
      {},
      { file_key: "img_wrong-prefix" },
      { file_key: "file_../secret" },
      { file_key: "file_https://example.invalid/upload" },
      { file_key: "file_has whitespace" },
    ]) {
      const cli = runner(response);
      await expect(
        uploadMedia(cli, {
          type: "file",
          fileName: "notes.md",
          cwd: "/tmp/feishu-stage",
        }),
      ).resolves.toEqual({
        status: "failed",
        code: "UPLOAD_MALFORMED_RESPONSE",
      });
      expect(cli.run).toHaveBeenCalledTimes(1);
    }
  });

  it("returns bounded safe error codes without exposing errors or retrying", async () => {
    const typed = runner();
    typed.run.mockRejectedValue(new FeishuCliError("CLI_TIMEOUT"));
    await expect(
      uploadMedia(typed, {
        type: "file",
        fileName: "notes.md",
        cwd: "/tmp/feishu-stage",
      }),
    ).resolves.toEqual({ status: "failed", code: "UPLOAD_CLI_TIMEOUT" });
    expect(typed.run).toHaveBeenCalledTimes(1);

    const unsafeTyped = runner();
    unsafeTyped.run.mockRejectedValue({ code: "app_secret secret" });
    await expect(
      uploadMedia(unsafeTyped, {
        type: "file",
        fileName: "notes.md",
        cwd: "/tmp/feishu-stage",
      }),
    ).resolves.toEqual({ status: "failed", code: "UPLOAD_FAILED" });
    expect(unsafeTyped.run).toHaveBeenCalledTimes(1);

    const untyped = runner();
    untyped.run.mockRejectedValue(
      new Error("secret message /tmp/feishu-stage/notes.md"),
    );
    const result = await uploadMedia(untyped, {
      type: "file",
      fileName: "notes.md",
      cwd: "/tmp/feishu-stage",
    });
    expect(result).toEqual({ status: "failed", code: "UPLOAD_FAILED" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("/tmp");
    expect(untyped.run).toHaveBeenCalledTimes(1);

    const tooLong = runner();
    tooLong.run.mockRejectedValue(new FeishuCliError("A".repeat(100)));
    await expect(
      uploadMedia(tooLong, {
        type: "file",
        fileName: "notes.md",
        cwd: "/tmp/feishu-stage",
      }),
    ).resolves.toEqual({ status: "failed", code: "UPLOAD_FAILED" });
    expect(tooLong.run).toHaveBeenCalledTimes(1);
  });

  it("matches the pinned binary upload field and parameter schemas offline", () => {
    const help = (command: string[]) =>
      execFileSync(binaryPath(), [...command, "--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    const schema = (name: string) =>
      JSON.parse(
        execFileSync(binaryPath(), ["schema", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as {
        inputSchema: {
          properties: {
            file: {
              required?: string[];
              properties?: Record<string, { enum?: string[] }>;
            };
            data: {
              required?: string[];
              properties?: Record<string, { enum?: string[] }>;
            };
          };
        };
        outputSchema: { properties: Record<string, unknown> };
      };
    for (const command of [
      ["im", "files", "create"],
      ["im", "images", "create"],
    ]) {
      const output = help(command);
      expect(output).toContain("--data string");
      expect(output).toContain("--file string");
      expect(output).toContain("--as string");
    }
    const files = schema("im.files.create");
    const images = schema("im.images.create");

    expect(files.inputSchema.properties.file.required).toEqual(["file"]);
    expect(files.inputSchema.properties.data.required).toEqual([
      "file_name",
      "file_type",
    ]);
    expect(
      files.inputSchema.properties.data.properties?.file_type?.enum,
    ).toContain("stream");
    expect(files.outputSchema.properties).toHaveProperty("file_key");
    expect(images.inputSchema.properties.file.required).toEqual(["image"]);
    expect(images.inputSchema.properties.data.required).toEqual(["image_type"]);
    expect(
      images.inputSchema.properties.data.properties?.image_type?.enum,
    ).toContain("message");
    expect(images.outputSchema.properties).toHaveProperty("image_key");
  });
});
