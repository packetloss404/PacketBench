import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

/** Extract a result object despite ConPTY escapes and SSH diagnostics. */
export function parseProviderResult(output) {
  const text = stripVTControlCharacters(output);
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const result = JSON.parse(text.slice(start, end + 1));
          if (result.type === "result") return result;
        } catch {
          // A diagnostic may contain braces which are not a JSON object.
        }
        break;
      }
    }
  }
  throw new Error("No provider result metadata in CLI output");
}

export function assertProviderReply(result, marker) {
  assert.equal(result.is_error, false, result.result || "Provider reported an error");
  assert.equal(result.subtype, "success");
  assert.equal(result.result.trim(), marker);
  assert(result.usage?.output_tokens > 0, "No provider output-token evidence");
  assert(result.num_turns > 0, "No completed provider turn");
}
