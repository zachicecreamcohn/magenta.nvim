import { registerScript } from "../../index.ts";

registerScript(
  "alpha",
  "the alpha script",
  { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
  async (_parameters, _thread, log) => {
    log("alpha ran");
  },
);

registerScript(
  "beta",
  "the beta script",
  { type: "object", properties: { y: { type: "number" } }, required: ["y"] },
  async (_parameters, _thread, log) => {
    log("beta ran");
  },
);
