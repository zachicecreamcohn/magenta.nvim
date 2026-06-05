import { registerScript } from "../../index.ts";

const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

registerScript(
  "sequential",
  "awaits two sequential threads",
  { type: "object", properties: {}, required: [] },
  async (_parameters, thread, log) => {
    log("starting");
    const first = await thread<{ value: string }>("first prompt", schema);
    const second = await thread<{ value: string }>(
      `second using ${first.value}`,
      schema,
    );
    log(`done ${second.value}`);
  },
);
