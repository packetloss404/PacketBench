import { describe, expect, it } from "vitest";
import { assertProviderReply, parseProviderResult } from "./provider-ssh-result.mjs";

const success = {
  is_error: false,
  result: "ACCEPTANCE_42",
  usage: { output_tokens: 5 },
  num_turns: 1,
  subtype: "success",
  type: "result",
};

describe("genuine SSH provider result evidence", () => {
  it("accepts reordered JSON fields through ConPTY with SSH diagnostics", () => {
    const output = `\x1b[?25l\x1b[H${JSON.stringify(success)}\r\n\x1b]0;ssh.exe\x07Connection closed.\r\n`;
    const parsed = parseProviderResult(output);
    expect(parsed).toEqual(success);
    expect(() => assertProviderReply(parsed, "ACCEPTANCE_42")).not.toThrow();
  });
  it("handles quoted braces and skips preceding diagnostic objects", () => {
    const result = { ...success, result: 'literal {brace} and "quote"' };
    expect(parseProviderResult(`warning {not JSON}\n{}\n${JSON.stringify(result)}`)).toEqual(
      result,
    );
  });
  it("rejects the expired OAuth result even when subtype misleadingly says success", () => {
    const result = {
      ...success,
      is_error: true,
      result: "401 OAuth access token has expired",
      usage: { output_tokens: 0 },
    };
    expect(() => assertProviderReply(result, "ACCEPTANCE_42")).toThrow(
      /OAuth access token has expired/,
    );
  });
  it("requires model-token evidence rather than accepting an echoed marker", () => {
    expect(() => parseProviderResult("ACCEPTANCE_42")).toThrow(/metadata/);
    expect(() =>
      assertProviderReply({ ...success, usage: { output_tokens: 0 } }, "ACCEPTANCE_42"),
    ).toThrow(/output-token/);
  });
});
