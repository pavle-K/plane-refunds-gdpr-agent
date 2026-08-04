import { env } from "../../config/env.js";
import type { EmailSendProvider } from "./email-send.port.js";
import { FakeEmailSendAdapter } from "./fake.adapter.js";
import { PostmarkEmailSendAdapter } from "./postmark.adapter.js";

export * from "./email-send.port.js";
export { FakeEmailSendAdapter } from "./fake.adapter.js";
export { PostmarkEmailSendAdapter } from "./postmark.adapter.js";

export function createEmailSendProvider(): EmailSendProvider {
  if (env.NODE_ENV === "test" || !env.POSTMARK_API_KEY) {
    return new FakeEmailSendAdapter();
  }
  return new PostmarkEmailSendAdapter(env.POSTMARK_API_KEY);
}
