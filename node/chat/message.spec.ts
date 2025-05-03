import { describe, it } from "vitest";
import { TMP_DIR, withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/toolManager";

describe("node/chat/message.spec.ts", () => {
  it("display multiple edits to the same file, and edit details", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file ${TMP_DIR}/poem.txt`,
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
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt`,
                find: `Moonlight whispers through the trees,\nSilver shadows dance with ease.`,
                replace: `Replace 1`,
              },
            },
          },
          {
            status: "ok",
            value: {
              id: "id2" as ToolRequestId,
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt`,
                find: `Stars above like diamonds bright,\nPaint their stories in the night.`,
                replace: `Replace 2`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
# user:
Update the poem in the file ${TMP_DIR}/poem.txt

# assistant:
ok, I will try to rewrite the poem in that file
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt
Stopped (end_turn) [input: 0, output: 0]

Edits:
  ${TMP_DIR}/poem.txt (2 edits). **[👀 review edits ]**

Stopped (end_turn)`);

      const reviewPos = await driver.assertDisplayBufferContains("Replace");
      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt
id: id1
replace: {
    filePath: ${TMP_DIR}/poem.txt
    match:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
\`\`\`
    replace:
\`\`\`
Replace 1
\`\`\`
}
Result:
\`\`\`
Successfully replaced content in node/test/tmp/poem.txt
\`\`\`
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt`);

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt
✏️ Replace [[ -2 / +1 ]] in \`${TMP_DIR}/poem.txt\` Success: Successfully replaced content in node/test/tmp/poem.txt
`);
    });
  });
});
