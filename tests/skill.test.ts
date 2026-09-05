import { access, readFile } from "node:fs/promises";

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
});
