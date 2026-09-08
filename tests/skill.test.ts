import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function pathExists(url: URL): Promise<boolean> {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

const skillRootUrl = new URL("../.agents/skills/send-wechat/", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const npmPackCommand =
  process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPackArgs =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --ignore-scripts --json"]
    : ["pack", "--dry-run", "--ignore-scripts", "--json"];

type PackManifest = {
  files: Array<{ path: string }>;
};

const markdownLinkPattern = /\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu;

function localMarkdownTarget(sourceUrl: URL, rawTarget: string): URL | null {
  const target =
    rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;
  const [path = ""] = target.split(/[?#]/u, 1);

  if (
    !path.toLowerCase().endsWith(".md") ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/iu.test(path)
  ) {
    return null;
  }

  return new URL(path, sourceUrl);
}

async function linkedMarkdownFiles(): Promise<URL[]> {
  const pending = [new URL("SKILL.md", skillRootUrl)];
  const visited = new Set<string>();
  const files: URL[] = [];

  while (pending.length > 0) {
    const sourceUrl = pending.shift()!;
    if (visited.has(sourceUrl.href)) continue;
    visited.add(sourceUrl.href);
    files.push(sourceUrl);

    const source = await readFile(sourceUrl, "utf8");
    for (const match of source.matchAll(markdownLinkPattern)) {
      const targetUrl = localMarkdownTarget(sourceUrl, match[1]!);
      if (targetUrl !== null) {
        expect(
          targetUrl.href.startsWith(skillRootUrl.href),
          `${sourceUrl.href} -> ${targetUrl.href}`,
        ).toBe(true);
        pending.push(targetUrl);
      }
    }
  }

  return files;
}

async function packedPaths(): Promise<Set<string>> {
  const { stdout } = await execFileAsync(npmPackCommand, npmPackArgs, {
    cwd: repositoryRoot,
    timeout: 15_000,
  });
  const [manifest] = JSON.parse(stdout) as PackManifest[];
  if (manifest === undefined) {
    throw new Error("npm pack returned no manifest");
  }
  return new Set(manifest.files.map(({ path }) => path));
}

describe("Agent skill discovery contract", () => {
  it("keeps the skill at the discoverable path and ships its directory in npm", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      files: string[];
    };
    const skillUrl = new URL("SKILL.md", skillRootUrl);
    const legacySkillUrl = new URL(
      "../skills/send-wechat/SKILL.md",
      import.meta.url,
    );

    expect(await pathExists(skillUrl)).toBe(true);
    expect(await pathExists(legacySkillUrl)).toBe(false);
    expect(packageJson.files).toContain(".agents/skills");
  });

  it("keeps implicit invocation and the direct send trigger in the skill metadata", async () => {
    const skill = await readFile(new URL("SKILL.md", skillRootUrl), "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
    const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1] ?? "";
    const policyUrl = new URL("agents/openai.yaml", skillRootUrl);

    expect(frontmatter).not.toMatch(/^\s*disable-model-invocation\s*:/mu);
    expect(description).toMatch(/发微信/u);
    expect(description).toMatch(/WeChat|Weixin/u);
    expect(description).toMatch(/message|file/u);
    expect(description).toMatch(/install|set up|pair|diagnos/u);

    if (await pathExists(policyUrl)) {
      const policy = await readFile(policyUrl, "utf8");
      expect(policy).not.toMatch(/allow_implicit_invocation\s*:\s*false\b/u);
    }
  });

  it(
    "ships every recursively linked local Markdown file with the skill",
    { timeout: 20_000 },
    async () => {
      const packagePaths = await packedPaths();
      const linkedFiles = await linkedMarkdownFiles();

      expect(linkedFiles.map((fileUrl) => fileUrl.href)).toContain(
        new URL("setup.md", skillRootUrl).href,
      );
      expect(linkedFiles.map((fileUrl) => fileUrl.href)).toContain(
        new URL("gateway.md", skillRootUrl).href,
      );

      for (const fileUrl of linkedFiles) {
        const filePath = fileURLToPath(fileUrl);
        const packagePath = filePath
          .slice(repositoryRoot.length)
          .replaceAll("\\", "/");

        expect(await pathExists(fileUrl), packagePath).toBe(true);
        expect(packagePaths, packagePath).toContain(packagePath);
      }
    },
  );
});
