import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import * as fs from "node:fs";
import * as path from "node:path";

describe("SkillsManager", () => {
  it("loads skills from a directory with skill.md", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "test-skill");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: test-skill
description: A test skill for testing
---

# Test Skill

This is the content of the test skill.
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(skillsManager.skills).toHaveProperty("test-skill");
        expect(skillsManager.skills["test-skill"]).toMatchObject({
          name: "test-skill",
          description: "A test skill for testing",
        });
      },
    );
  });

  it("handles case-insensitive skill.md filename", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "case-test");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "SKILL.MD"),
            `---
name: case-test-skill
description: Testing case insensitivity
---
Content here
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(skillsManager.skills).toHaveProperty("case-test-skill");
      },
    );
  });

  it("skips skills with missing YAML frontmatter", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(
            tmpDir,
            ".claude",
            "skills",
            "no-frontmatter",
          );
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `# No Frontmatter

Just regular markdown content without frontmatter.
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(Object.keys(skillsManager.skills)).toHaveLength(0);
      },
    );
  });

  it("skips skills with missing required fields", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(
            tmpDir,
            ".claude",
            "skills",
            "missing-fields",
          );
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: only-name
---
Content
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(Object.keys(skillsManager.skills)).toHaveLength(0);
      },
    );
  });

  it("warns about duplicate skill names", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill1");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill2");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: duplicate-name
description: First skill with this name
---
Content 1
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: duplicate-name
description: Second skill with this name
---
Content 2
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        // Should only have one skill (glob order is not guaranteed)
        expect(Object.keys(skillsManager.skills)).toHaveLength(1);
        expect(skillsManager.skills["duplicate-name"]).toBeDefined();

        // The description should be one of the two (whichever glob found first)
        const description = skillsManager.skills["duplicate-name"].description;
        expect(
          description === "First skill with this name" ||
            description === "Second skill with this name",
        ).toBe(true);
      },
    );
  });

  it("generates skills introduction only once", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "intro-test");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: intro-skill
description: Testing introduction generation
---
Content
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        const firstIntro = skillsManager.getSkillsIntroduction();
        expect(firstIntro).toBeTruthy();
        expect(firstIntro).toContain("intro-skill");
        expect(firstIntro).toContain("Testing introduction generation");

        const secondIntro = skillsManager.getSkillsIntroduction();
        expect(secondIntro).toBeUndefined();
      },
    );
  });

  it("resets and allows showing skills introduction again", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "reset-test");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: reset-skill
description: Testing reset
---
Content
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        const firstIntro = skillsManager.getSkillsIntroduction();
        expect(firstIntro).toBeTruthy();

        const secondIntro = skillsManager.getSkillsIntroduction();
        expect(secondIntro).toBeUndefined();

        skillsManager.reset();

        const thirdIntro = skillsManager.getSkillsIntroduction();
        expect(thirdIntro).toBeTruthy();
      },
    );
  });

  it("returns empty when no skills are configured", async () => {
    await withDriver(
      {
        options: {
          skillsPaths: [],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(skillsManager.isEmpty()).toBe(true);
        expect(skillsManager.getSkillsIntroduction()).toBeUndefined();
      },
    );
  });

  it("handles multiple skills from different directories", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill-a");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill-b");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: skill-a
description: First skill
---
Content A
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: skill-b
description: Second skill
---
Content B
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(Object.keys(skillsManager.skills)).toHaveLength(2);
        expect(skillsManager.skills).toHaveProperty("skill-a");
        expect(skillsManager.skills).toHaveProperty("skill-b");

        const intro = skillsManager.getSkillsIntroduction();
        expect(intro).toContain("skill-a");
        expect(intro).toContain("skill-b");
        expect(intro).toContain("First skill");
        expect(intro).toContain("Second skill");
      },
    );
  });

  it("handles non-existent skills directory gracefully", async () => {
    await withDriver(
      {
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const skillsManager =
          driver.magenta.chat.getActiveThread().context.skillsManager;

        expect(skillsManager.isEmpty()).toBe(true);
        expect(Object.keys(skillsManager.skills)).toHaveLength(0);
      },
    );
  });

  it("includes skills introduction in first user message", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill-a");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill-b");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: skill-a
description: First skill description
---
Content A
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: skill-b
description: Second skill description
---
Content B
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills/*"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // Send first user message
        await driver.inputMagentaText("hello");
        await driver.send();

        const firstRequest = await driver.mockAnthropic.awaitPendingRequest();

        // Check that skills introduction is in the first message
        const firstMessageContent = firstRequest.messages[0].content;
        const textContent = Array.isArray(firstMessageContent)
          ? firstMessageContent.find((c) => c.type === "text")?.text
          : firstMessageContent;

        expect(textContent).toContain("Here are skills you have available");
        expect(textContent).toContain("skill-a");
        expect(textContent).toContain("skill-b");
        expect(textContent).toContain("First skill description");
        expect(textContent).toContain("Second skill description");
        expect(textContent).toContain("get_file tool");

        firstRequest.respond({
          stopReason: "end_turn",
          text: "Got it!",
          toolRequests: [],
        });

        // Send second user message
        await driver.inputMagentaText("second message");
        await driver.send();

        const secondRequest = await driver.mockAnthropic.awaitPendingRequest();

        // Check that skills introduction is NOT in the second message
        const secondMessageContent =
          secondRequest.messages[secondRequest.messages.length - 1].content;
        const secondTextContent = Array.isArray(secondMessageContent)
          ? secondMessageContent.find((c) => c.type === "text")?.text
          : secondMessageContent;

        expect(secondTextContent).not.toContain(
          "Here are skills you have available",
        );
        expect(secondTextContent).toContain("second message");
      },
    );
  });
});
