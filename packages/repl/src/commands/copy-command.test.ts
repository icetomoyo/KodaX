import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyCommand } from "./copy-command.js";
import { extractLastAssistantText } from "../ui/utils/message-utils.js";
import { copyTextToClipboard } from "../common/clipboard.js";

vi.mock("../common/clipboard.js", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue({ path: "native" }),
}));

describe("copyCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies the last assistant message to the clipboard", async () => {
    const context = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "first answer" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "latest answer" },
            { type: "tool_result", text: "ignored" },
          ],
        },
      ],
    };

    await copyCommand.handler([], context as never, {} as never, {} as never);

    expect(copyTextToClipboard).toHaveBeenCalledWith("latest answer");
  });

  it("uses the same assistant text normalization as the UI history", async () => {
    const context = {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "## Verifying" },
            { type: "text", text: "" },
            { type: "text", text: "```bash" },
            { type: "text", text: "mysql -h 127.0.0.1 -P 13306" },
            { type: "text", text: "```" },
            { type: "text", text: "" },
            { type: "text", text: "**Key**: the last line must still be shown" },
          ],
        },
      ],
    };
    const expected = extractLastAssistantText(context.messages as never);

    await copyCommand.handler([], context as never, {} as never, {} as never);

    expect(copyTextToClipboard).toHaveBeenCalledWith(expected);
  });

  it("does nothing when there is no assistant message", async () => {
    const context = {
      messages: [{ role: "user", content: "hello" }],
    };

    await copyCommand.handler([], context as never, {} as never, {} as never);

    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });

  it("copies the Host's newest reply when the client keeps no transcript", async () => {
    const readLastAssistantReply = vi.fn(async () => "reply from the Host");

    await copyCommand.handler([], { messages: [] } as never, { readLastAssistantReply } as never, {} as never);

    expect(copyTextToClipboard).toHaveBeenCalledWith("reply from the Host");
  });

  it("reports a failed Host read instead of copying nothing silently", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const readLastAssistantReply = vi.fn(async () => { throw new Error("Host unreachable"); });

    await copyCommand.handler([], { messages: [] } as never, { readLastAssistantReply } as never, {} as never);

    expect(copyTextToClipboard).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Host unreachable"));
  });

  it("logs a friendly error when clipboard write fails", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("permission denied"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const context = {
      messages: [{ role: "assistant", content: "hello" }],
    };

    await copyCommand.handler([], context as never, {} as never, {} as never);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to copy to clipboard: permission denied"));
  });
});
