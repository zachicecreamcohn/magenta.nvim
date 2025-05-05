/**
 * Strips all <think>...</think> sections from a text
 * Used for models that use cot
 */
export function stripThinking(text: string): string {
  const openTag = "<think>";
  const closeTag = "</think>";

  let result = "";
  let i = 0;

  while (i < text.length) {
    const openIndex = text.indexOf(openTag, i);

    if (openIndex === -1) {
      result += text.substring(i);
      break;
    }

    result += text.substring(i, openIndex);

    let depth = 1;
    let j = openIndex + openTag.length;

    while (depth > 0 && j < text.length) {
      const nextOpenIndex = text.indexOf(openTag, j);
      const nextCloseIndex = text.indexOf(closeTag, j);

      if (nextCloseIndex === -1) {
        result += text.substring(openIndex);
        i = text.length;
        break;
      }

      if (nextOpenIndex !== -1 && nextOpenIndex < nextCloseIndex) {
        depth++;
        j = nextOpenIndex + openTag.length;
      } else {
        depth--;
        j = nextCloseIndex + closeTag.length;

        if (depth === 0) {
          i = j;
        }
      }
    }
  }

  return result;
}
