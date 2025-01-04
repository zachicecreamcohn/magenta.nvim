import { describe, it } from "bun:test";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/toolManager";
import { REVIEW_PROMPT } from "../tools/diff";

describe("bun/chat/message.spec.ts", () => {
  it("display multiple edits to the same file, and edit details", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file bun/test/fixtures/poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id1" as ToolRequestId,
              name: "replace",
              input: {
                filePath: "bun/test/fixtures/poem.txt",
                startLine: `Moonlight whispers through the trees,`,
                endLine: `Silver shadows dance with ease.`,
                replace: `Replace 1`,
              },
            },
          },
          {
            status: "ok",
            value: {
              id: "id2" as ToolRequestId,
              name: "replace",
              input: {
                filePath: "bun/test/fixtures/poem.txt",
                startLine: `Stars above like diamonds bright,`,
                endLine: `Paint their stories in the night.`,
                replace: `Replace 2`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file

Edits:
  bun/test/fixtures/poem.txt (2 edits). **[👀 review edits ]**
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.
`);

      const reviewPos = await driver.assertDisplayBufferContains("Replace");
      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file

Edits:
  bun/test/fixtures/poem.txt (2 edits). **[👀 review edits ]**
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.
replace: {
    filePath: bun/test/fixtures/poem.txt
    match:
\`\`\`
Moonlight whispers through the trees,
...
Silver shadows dance with ease.
\`\`\`
    replace:
\`\`\`
Replace 1
\`\`\`
}
Result:
\`\`\`
${REVIEW_PROMPT}
\`\`\`
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.`);

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file

Edits:
  bun/test/fixtures/poem.txt (2 edits). **[👀 review edits ]**
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.
    Replace [[ -? / +1 ]] in bun/test/fixtures/poem.txt Awaiting user review.
`);
    });
  });
});
