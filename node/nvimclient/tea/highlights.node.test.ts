import type { DisplayBufferText } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { findInDisplayBufferText } from "./highlights.ts";

const t = (s: string) => s as DisplayBufferText;

describe("findInDisplayBufferText", () => {
  it("finds within a line, across lines, and the first repeat", () => {
    expect(findInDisplayBufferText(t("abc def"), t("def"))).toEqual({
      start: 4,
      end: 7,
    });
    expect(findInDisplayBufferText(t("ab\ncd"), t("b\nc"))).toEqual({
      start: 1,
      end: 4,
    });
    expect(findInDisplayBufferText(t("xx xx"), t("xx"))).toEqual({
      start: 0,
      end: 2,
    });
    expect(findInDisplayBufferText(t("abc"), t("zzz"))).toBeUndefined();
  });

  it("returns byte offsets for multibyte text", () => {
    expect(findInDisplayBufferText(t("é→ ok"), t("ok"))).toEqual({
      start: 6,
      end: 8,
    });
  });

  it("rejects plain strings at the type level", () => {
    // @ts-expect-error plain string is not display buffer text
    findInDisplayBufferText("abc", t("a"));
  });
});
