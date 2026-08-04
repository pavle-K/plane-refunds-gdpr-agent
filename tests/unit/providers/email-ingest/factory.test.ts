import { describe, it, expect } from "vitest";
import { createEmailIngestProvider } from "../../../../src/providers/email-ingest/index.js";
import { FakeEmailIngestAdapter } from "../../../../src/providers/email-ingest/fake.adapter.js";

describe("createEmailIngestProvider", () => {
  it("always returns the fake adapter under NODE_ENV=test, regardless of any stored connection", async () => {
    const provider = await createEmailIngestProvider();
    expect(provider).toBeInstanceOf(FakeEmailIngestAdapter);
  });
});
