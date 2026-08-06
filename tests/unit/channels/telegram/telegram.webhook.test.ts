import { describe, it, expect } from "vitest";
import { parseTelegramUpdate } from "../../../../src/channels/telegram/telegram.webhook.js";

describe("parseTelegramUpdate", () => {
  it("maps a plain text message update to InboundMessage", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 42, is_bot: false, first_name: "Ada" },
        chat: { id: 42, type: "private" },
        date: 1700000000,
        text: "hello there",
      },
    };

    expect(parseTelegramUpdate(update)).toEqual({ externalUserId: "42", text: "hello there" });
  });

  it("returns null for updates with no message (e.g. edited_message-only updates)", () => {
    expect(parseTelegramUpdate({ update_id: 1, edited_message: { text: "edited" } })).toBeNull();
  });

  it("returns null for non-text messages (e.g. a photo with no caption)", () => {
    const update = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 42, type: "private" }, date: 1700000000, photo: [{ file_id: "abc" }] },
    };

    expect(parseTelegramUpdate(update)).toBeNull();
  });

  it("returns null for malformed/unexpected payloads", () => {
    expect(parseTelegramUpdate(null)).toBeNull();
    expect(parseTelegramUpdate("not an object")).toBeNull();
    expect(parseTelegramUpdate({})).toBeNull();
    expect(parseTelegramUpdate({ message: { text: "hi", chat: null } })).toBeNull();
  });
});
