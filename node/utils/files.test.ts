import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  detectFileType,
  categorizeFileType,
  isLikelyTextFile,
  validateFileSize,
  FileCategory,
  FILE_SIZE_LIMITS,
} from "./files";
import { TMP_DIR, withNvimProcess } from "../test/preamble";

describe("categorizeFileType", () => {
  it("should categorize text MIME types correctly", () => {
    expect(categorizeFileType("text/plain")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("text/html")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("text/css")).toBe(FileCategory.TEXT);
  });

  it("should categorize code MIME types correctly", () => {
    expect(categorizeFileType("application/javascript")).toBe(
      FileCategory.TEXT,
    );
    expect(categorizeFileType("application/json")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("application/xml")).toBe(FileCategory.TEXT);
  });

  it("should categorize image MIME types correctly", () => {
    expect(categorizeFileType("image/jpeg")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/png")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/gif")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/webp")).toBe(FileCategory.IMAGE);
  });

  it("should categorize PDF MIME type correctly", () => {
    expect(categorizeFileType("application/pdf")).toBe(FileCategory.PDF);
  });

  it("should categorize unsupported MIME types correctly", () => {
    expect(categorizeFileType("video/mp4")).toBe(FileCategory.UNSUPPORTED);
    expect(categorizeFileType("application/octet-stream")).toBe(
      FileCategory.UNSUPPORTED,
    );
    expect(categorizeFileType("image/tiff")).toBe(FileCategory.UNSUPPORTED);
  });
});

describe("isLikelyTextFile", () => {
  it("should detect text files by extension", async () => {
    await withNvimProcess(async () => {
      const textFile = path.join(TMP_DIR, "poem.txt");
      expect(await isLikelyTextFile(textFile)).toBe(true);
    });
  });

  it("should detect code files by extension", async () => {
    await withNvimProcess(async () => {
      const tsFile = path.join(TMP_DIR, "test.ts");
      expect(await isLikelyTextFile(tsFile)).toBe(true);
    });
  });

  it("should detect binary files by content", async () => {
    await withNvimProcess(async () => {
      const binaryFile = path.join(TMP_DIR, "test.bin");
      expect(await isLikelyTextFile(binaryFile)).toBe(false);
    });
  });

  it("should handle non-existent files gracefully", async () => {
    const nonExistentFile = path.join(TMP_DIR, "nonexistent.txt");
    expect(await isLikelyTextFile(nonExistentFile)).toBe(false);
  });
});

describe("detectFileType", () => {
  it("should detect text files correctly", async () => {
    await withNvimProcess(async () => {
      const textFile = path.join(TMP_DIR, "poem.txt");
      const result = await detectFileType(textFile);

      expect(result.category).toBe(FileCategory.TEXT);
      expect(result.mimeType).toBe("text/plain");
      expect(result.extension).toBe(".txt");
    });
  });

  it("should detect TypeScript files correctly", async () => {
    await withNvimProcess(async () => {
      const tsFile = path.join(TMP_DIR, "test.ts");
      const result = await detectFileType(tsFile);

      expect(result.category).toBe(FileCategory.TEXT);
      // TypeScript files may be detected as text/plain if no magic number is found
      expect(result.mimeType).toMatch(
        /^(application\/typescript|text\/plain)$/,
      );
      expect(result.extension).toBe(".ts");
    });
  });

  it("should detect JSON files correctly", async () => {
    await withNvimProcess(async () => {
      const jsonFile = path.join(TMP_DIR, "tsconfig.json");
      const result = await detectFileType(jsonFile);

      expect(result.category).toBe(FileCategory.TEXT);
      expect(result.mimeType).toBe("application/json");
      expect(result.extension).toBe(".json");
    });
  });

  it("should detect JPEG images correctly", async () => {
    await withNvimProcess(async () => {
      const jpegFile = path.join(TMP_DIR, "test.jpg");
      const result = await detectFileType(jpegFile);

      expect(result.category).toBe(FileCategory.IMAGE);
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.extension).toBe(".jpg");
    });
  });

  it("should detect PDF files correctly", async () => {
    await withNvimProcess(async () => {
      const pdfFile = path.join(TMP_DIR, "test.pdf");
      const result = await detectFileType(pdfFile);

      expect(result.category).toBe(FileCategory.PDF);
      expect(result.mimeType).toBe("application/pdf");
      expect(result.extension).toBe(".pdf");
    });
  });

  it("should detect binary files as unsupported", async () => {
    await withNvimProcess(async () => {
      const binaryFile = path.join(TMP_DIR, "test.bin");
      const result = await detectFileType(binaryFile);

      expect(result.category).toBe(FileCategory.UNSUPPORTED);
    });
  });
});

describe("validateFileSize", () => {
  it("should validate text file sizes correctly", async () => {
    const textFile = path.join(TMP_DIR, "poem.txt");
    const result = await validateFileSize(textFile, FileCategory.TEXT);

    expect(result.isValid).toBe(true);
    expect(result.actualSize).toBeGreaterThan(0);
    expect(result.maxSize).toBe(FILE_SIZE_LIMITS.TEXT);
  });

  it("should reject oversized text files", async () => {
    const largeFile = path.join(TMP_DIR, "large.txt");

    // Create a file that exceeds the text file size limit
    const content = "x".repeat(FILE_SIZE_LIMITS.TEXT + 1000);
    await fs.writeFile(largeFile, content);

    const result = await validateFileSize(largeFile, FileCategory.TEXT);

    expect(result.isValid).toBe(false);
    expect(result.actualSize).toBeGreaterThan(FILE_SIZE_LIMITS.TEXT);
    expect(result.maxSize).toBe(FILE_SIZE_LIMITS.TEXT);
  });
});
