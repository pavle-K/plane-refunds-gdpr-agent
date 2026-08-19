import { describe, it, expect } from "vitest";
import { buildEmailConnectedPostMessageScript } from "../../../../src/api/routes/oauth.routes.js";

describe("buildEmailConnectedPostMessageScript", () => {
  it("posts the provider and email address to the given target origin and closes the window", () => {
    const script = buildEmailConnectedPostMessageScript("https://claims.example.com", {
      provider: "gmail",
      emailAddress: "user@example.com",
    });

    expect(script).toContain("window.opener.postMessage(");
    expect(script).toContain('"type":"email_connected"');
    expect(script).toContain('"provider":"gmail"');
    expect(script).toContain('"emailAddress":"user@example.com"');
    expect(script).toContain('"https://claims.example.com"');
    expect(script).toContain("window.close()");
  });

  it("guards the postMessage call behind window.opener, since the same callback page also renders for non-popup flows", () => {
    const script = buildEmailConnectedPostMessageScript("https://claims.example.com", {
      provider: "outlook",
      emailAddress: "user@example.com",
    });
    expect(script.trim().startsWith("if (window.opener)")).toBe(true);
  });

  it("never emits a raw </script sequence, even from a maximally adversarial email address", () => {
    // Not a realistic value (this never actually reaches here unvalidated —
    // see the function's own doc comment) — this is a defense-in-depth check
    // on the escaping itself, not a claim that this input is reachable.
    const script = buildEmailConnectedPostMessageScript("https://claims.example.com", {
      provider: "gmail",
      emailAddress: '</script><script>alert(1)</script>',
    });
    expect(script.toLowerCase()).not.toContain("</script");
  });
});
