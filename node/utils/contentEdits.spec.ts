import { describe, expect, it } from "vitest";
import { applyInsert, applyReplace, findForgivingMatch } from "./contentEdits";

describe("node/utils/contentEdits.spec.ts", () => {
  describe("findForgivingMatch", () => {
    it("finds exact match", () => {
      const contentLines = ["line1", "line2", "line3"];
      const findLines = ["line1", "line2"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 0, end: 2 });
    });

    it("finds match with whitespace differences", () => {
      const contentLines = ["  line1  ", "line2"];
      const findLines = ["line1", "line2"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 0, end: 2 });
    });

    it("finds match with semicolon differences", () => {
      const contentLines = ["const x = 1", "const y = 2"];
      const findLines = ["const x = 1;", "const y = 2;"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 0, end: 2 });
    });

    it("finds match with mixed whitespace and semicolon differences", () => {
      const contentLines = ["  const x = 1  ", "const y = 2"];
      const findLines = ["const x = 1;", "const y = 2;"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 0, end: 2 });
    });

    it("finds match in the middle of content", () => {
      const contentLines = ["line1", "target1", "target2", "line4"];
      const findLines = ["target1", "target2"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 1, end: 3 });
    });

    it("returns null when no match is found", () => {
      const contentLines = ["line1", "line2", "line3"];
      const findLines = ["missing", "lines"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toBeNull();
    });

    it("returns 'multiple' when multiple matches are found", () => {
      const contentLines = [
        "const x = 1",
        "const y = 2",
        "",
        "const x = 1",
        "const y = 2",
      ];
      const findLines = ["const x = 1", "const y = 2"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual("multiple");
    });

    it("handles empty find lines", () => {
      const contentLines = ["line1", "line2"];
      const findLines: string[] = [];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toBeNull();
    });

    it("handles single line matches", () => {
      const contentLines = ["line1", "target", "line3"];
      const findLines = ["target"];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 1, end: 2 });
    });

    it("handles complex real-world example", () => {
      const contentLines = [
        'import React, { Dispatch } from "react";',
        'import { Update, View } from "../tea";',
        'import * as immer from "immer";',
        'import * as MeasureSelectionBox from "./measure-selection-box";',
        'import { InitialFilter, UnitType } from "../../iso/units";',
      ];
      const findLines = [
        'import React, { Dispatch } from "react";',
        'import { Update, View } from "../tea";',
        'import * as immer from "immer";',
        'import * as MeasureSelectionBox from "./measure-selection-box";',
      ];
      const result = findForgivingMatch(contentLines, findLines);
      expect(result).toEqual({ start: 0, end: 4 });
    });
  });

  describe("applyInsert", () => {
    it("inserts content after specified text", () => {
      const content = "Hello world";
      const result = applyInsert(content, "Hello", " beautiful");
      expect(result.status).toEqual("ok");
      if (result.status === "ok") {
        expect(result.content).toEqual("Hello beautiful world");
      }
    });

    it("appends to end when insertAfter is empty", () => {
      const content = "Hello";
      const result = applyInsert(content, "", " world");
      expect(result.status).toEqual("ok");
      if (result.status === "ok") {
        expect(result.content).toEqual("Hello world");
      }
    });

    it("fails when insertAfter text is not found", () => {
      const content = "Hello world";
      const result = applyInsert(content, "missing", " text");
      expect(result.status).toEqual("error");
      if (result.status === "error") {
        expect(result.error).toContain("Unable to find insert location");
      }
    });
  });

  describe("applyReplace", () => {
    describe("exact matching", () => {
      it("replaces exact text match", () => {
        const content = "Hello world";
        const result = applyReplace(content, "world", "universe");
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual("Hello universe");
        }
      });

      it("replaces entire content when find is empty", () => {
        const content = "Hello world";
        const result = applyReplace(content, "", "Goodbye");
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual("Goodbye");
        }
      });

      it("replaces multiline content", () => {
        const content = "Line 1\nLine 2\nLine 3";
        const result = applyReplace(
          content,
          "Line 1\nLine 2",
          "New Line 1\nNew Line 2",
        );
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual("New Line 1\nNew Line 2\nLine 3");
        }
      });
    });

    describe("forgiving matching", () => {
      it("handles whitespace mismatch at beginning of lines", () => {
        const content = `function test() {
  const x = 1;
    const y = 2;
  return x + y;
}`;

        const findText = `function test() {
const x = 1;
  const y = 2;
return x + y;
}`;

        const replaceText = `function test() {
const z = 3;
return z;
}`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual(replaceText);
        }
      });

      it("handles whitespace mismatch at end of lines", () => {
        const content = `const a = 1;
const b = 2;
const c = 3;`;

        const findText = `const a = 1;
const b = 2;
const c = 3;`;

        const replaceText = `const x = 4;
const y = 5;`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual(replaceText);
        }
      });

      it("handles semicolon mismatches", () => {
        const content = `import React from "react"
import { useState } from "react"
import * as lodash from "lodash"`;

        const findText = `import React from "react";
import { useState } from "react";
import * as lodash from "lodash";`;

        const replaceText = `import React from "react";
import * as lodash from "lodash";`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual(`import React from "react";
import * as lodash from "lodash";`);
        }
      });

      it("handles mixed whitespace and semicolon mismatches", () => {
        const content = `  const obj = {
    prop1: "value1",
    prop2: "value2"
  }`;

        const findText = `const obj = {
  prop1: "value1";
  prop2: "value2";
}`;

        const replaceText = `const newObj = {
  prop: "value"
}`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual(replaceText);
        }
      });

      it("handles real-world import example", () => {
        const content = `import React, { Dispatch } from "react";
import { Update, View } from "../tea";
import * as immer from "immer";
import * as MeasureSelectionBox from "./measure-selection-box";
import { InitialFilter, UnitType } from "../../iso/units";`;

        const findText = `import React, { Dispatch } from "react";
import { Update, View } from "../tea";
import * as immer from "immer";
import * as MeasureSelectionBox from "./measure-selection-box";`;

        const replaceText = `import React, { Dispatch } from "react";
import * as MeasureSelectionBox from "./measure-selection-box";`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content)
            .toEqual(`import React, { Dispatch } from "react";
import * as MeasureSelectionBox from "./measure-selection-box";
import { InitialFilter, UnitType } from "../../iso/units";`);
        }
      });
    });

    describe("error cases", () => {
      it("fails when text is not found", () => {
        const content = "Hello world";
        const result = applyReplace(content, "missing", "replacement");
        expect(result.status).toEqual("error");
        if (result.status === "error") {
          expect(result.error).toContain("Unable to find text");
        }
      });

      it("replaces first match when multiple matches exist (exact matching)", () => {
        const content = `const x = 1;
const y = 2;

const x = 1;
const y = 2;

const z = 3;`;

        const findText = `const x = 1;
const y = 2;`;

        const replaceText = `const a = 4;
const b = 5;`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("ok");
        if (result.status === "ok") {
          expect(result.content).toEqual(`const a = 4;
const b = 5;

const x = 1;
const y = 2;

const z = 3;`);
        }
      });

      it("still fails when content is genuinely different", () => {
        const content = `function add(a, b) {
  return a + b;
}`;

        const findText = `function subtract(a, b) {
  return a - b;
}`;

        const replaceText = `function multiply(a, b) {
  return a * b;
}`;

        const result = applyReplace(content, findText, replaceText);
        expect(result.status).toEqual("error");
        if (result.status === "error") {
          expect(result.error).toContain("Unable to find text");
        }
      });
    });
  });
});
