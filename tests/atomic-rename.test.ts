import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { rename } from "node:fs/promises";

import { renameFile } from "../src/platform/atomic-rename.js";
import {
  gatewayConfigSchema,
  readGatewayFile,
  writeGatewayFile,
} from "../src/gateway/storage.js";

const roots: string[] = [];
const mockedRename = vi.mocked(rename);

afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  mockedRename.mockReset();
  mockedRename.mockImplementation(actual.rename);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureFiles(): Promise<{
  directory: string;
  original: string;
  temporary: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "send-wechat-atomic-rename-"));
  roots.push(directory);
  const original = join(directory, "status.json");
  const temporary = join(directory, "status.json.tmp");
  await writeFile(original, "old\n");
  await writeFile(temporary, "new\n");
  return { directory, original, temporary };
}

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("atomic rename", () => {
  it("retries a transient Windows failure and replaces the destination", async () => {
    const { original, temporary } = await fixtureFiles();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    mockedRename.mockRejectedValueOnce(errorWithCode("EPERM"));
    mockedRename.mockImplementationOnce(async (from, to) => {
      expect(await readFile(original, "utf8")).toBe("old\n");
      return actual.rename(from, to);
    });

    await expect(
      renameFile(temporary, original, "win32"),
    ).resolves.toBeUndefined();

    expect(mockedRename).toHaveBeenCalledTimes(2);
    await expect(readFile(original, "utf8")).resolves.toBe("new\n");
    await expect(readFile(temporary, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["EPERM", "EACCES", "EBUSY"] as const)(
    "retries Windows transient %s errors",
    async (code) => {
      const { original, temporary } = await fixtureFiles();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      mockedRename
        .mockRejectedValueOnce(errorWithCode(code))
        .mockRejectedValueOnce(errorWithCode(code))
        .mockRejectedValueOnce(errorWithCode(code));
      mockedRename.mockImplementationOnce(async (from, to) => {
        expect(await readFile(original, "utf8")).toBe("old\n");
        return actual.rename(from, to);
      });

      await expect(
        renameFile(temporary, original, "win32"),
      ).resolves.toBeUndefined();

      expect(mockedRename).toHaveBeenCalledTimes(4);
      await expect(readFile(original, "utf8")).resolves.toBe("new\n");
    },
  );

  it("bounds permanent Windows retries and leaves both files for the caller", async () => {
    const { original, temporary } = await fixtureFiles();
    const error = errorWithCode("EPERM");
    for (let attempt = 0; attempt < 11; attempt += 1) {
      mockedRename.mockRejectedValueOnce(error);
    }

    await expect(renameFile(temporary, original, "win32")).rejects.toBe(error);

    expect(mockedRename.mock.calls.length).toBeLessThanOrEqual(11);
    expect(mockedRename.mock.calls.length).toBeGreaterThan(1);
    await expect(readFile(original, "utf8")).resolves.toBe("old\n");
    await expect(readFile(temporary, "utf8")).resolves.toBe("new\n");
  });

  it.each(["ENOENT", "EIO"] as const)(
    "does not retry non-transient Windows %s errors",
    async (code) => {
      const { original, temporary } = await fixtureFiles();
      const error = errorWithCode(code);
      mockedRename.mockRejectedValueOnce(error);

      await expect(renameFile(temporary, original, "win32")).rejects.toBe(
        error,
      );

      expect(mockedRename).toHaveBeenCalledTimes(1);
      await expect(readFile(original, "utf8")).resolves.toBe("old\n");
      await expect(readFile(temporary, "utf8")).resolves.toBe("new\n");
    },
  );

  it("uses one attempt for EPERM on non-Windows platforms", async () => {
    const { original, temporary } = await fixtureFiles();
    const error = errorWithCode("EPERM");
    mockedRename.mockRejectedValueOnce(error);

    await expect(renameFile(temporary, original, "darwin")).rejects.toBe(error);

    expect(mockedRename).toHaveBeenCalledTimes(1);
    await expect(readFile(original, "utf8")).resolves.toBe("old\n");
    await expect(readFile(temporary, "utf8")).resolves.toBe("new\n");
  });

  it("leaves an old gateway JSON file and cleans its temp file after rename failure", async () => {
    const { directory, original } = await fixtureFiles();
    const oldConfig = {
      schemaVersion: 1 as const,
      installationId: "11111111-1111-4111-8111-111111111111",
      codexExecutable: "/opt/codex/bin/codex",
      workingDirectory: "/workspace/project",
      searchPath: "/opt/codex/bin:/usr/bin",
    };
    await rm(original);
    await rm(`${original}.tmp`);
    await writeGatewayFile(original, gatewayConfigSchema, oldConfig);
    mockedRename.mockClear();
    mockedRename.mockRejectedValueOnce(errorWithCode("EIO"));

    await expect(
      writeGatewayFile(original, gatewayConfigSchema, {
        ...oldConfig,
        searchPath: "/new/path",
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    await expect(
      readGatewayFile(original, gatewayConfigSchema),
    ).resolves.toEqual(oldConfig);
    await expect(readdir(directory)).resolves.toEqual(["status.json"]);
  });
});
