import { registerScript } from "../../index.ts";

registerScript(
  "worker",
  "logs then spawns a thread",
  { type: "object", properties: {}, required: [] },
  async (_parameters, thread, log) => {
    log("hi");
    const result = await thread<{ answer: number }>("p", {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    });
    log(`got ${result.answer}`);
  },
);
