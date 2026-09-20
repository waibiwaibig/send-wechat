import {
  chmod,
  mkdir,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachmentStore } from "../src/messaging/attachments.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "send-message-attachments-"));
  roots.push(root);
  return { root, directory: path.join(root, "private") };
}

describe("AttachmentStore", () => {
  it("uses a generated local path independent of a hostile filename", async () => {
    const { directory } = await fixture();
    const destination = await new AttachmentStore(directory).save(
      "../../escape;$(touch-pwned).png",
      async (file) => {
        await writeFile(file, "payload");
      },
    );

    expect(path.dirname(destination)).toBe(directory);
    expect(path.basename(destination)).not.toContain("escape");
    expect(path.basename(destination)).toMatch(/^[0-9a-f-]{36}\.png$/);
    await expect(stat(destination)).resolves.toMatchObject({ size: 7 });
  });

  it("removes a newly created file when downloading fails", async () => {
    const { directory } = await fixture();
    await expect(
      new AttachmentStore(directory).save("failed.bin", async (file) => {
        await writeFile(file, "partial");
        throw new Error("download failed");
      }),
    ).rejects.toThrow("download failed");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("clears expired files before admitting a new attachment", async () => {
    const { directory } = await fixture();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const expired = path.join(directory, "old.bin");
    await writeFile(expired, "old");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(expired, old, old);

    const destination = await new AttachmentStore(directory).save(
      "new.txt",
      async (file) => writeFile(file, "new"),
    );

    await expect(stat(destination)).resolves.toMatchObject({ size: 3 });
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a storage directory with broad permissions",
    async () => {
      const { directory } = await fixture();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o755);

      await expect(
        new AttachmentStore(directory).save(
          "unsafe.bin",
          async () => undefined,
        ),
      ).rejects.toThrow("ATTACHMENT_DIRECTORY_UNSAFE");
    },
  );
});
