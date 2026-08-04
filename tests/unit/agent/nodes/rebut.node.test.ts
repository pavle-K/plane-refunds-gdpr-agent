import { describe, it, expect } from "vitest";
import { createRebutNode } from "../../../../src/agent/nodes/rebut.node.js";
import { IllegalTransitionError } from "../../../../src/domain/claim/state-machine.js";
import { buildState } from "../../../helpers/build-state.js";

describe("rebut node", () => {
  it("transitions rejected → rebutting and increments rebuttalCount", async () => {
    const node = createRebutNode();
    const result = await node(buildState({ claimStatus: "rejected", rebuttalCount: 0 }));

    expect(result.claimStatus).toBe("rebutting");
    expect(result.rebuttalCount).toBe(1);
  });

  it("increments across repeated rebuttals", async () => {
    const node = createRebutNode();
    const result = await node(buildState({ claimStatus: "rejected", rebuttalCount: 1 }));
    expect(result.rebuttalCount).toBe(2);
  });

  it("refuses to rebut from a status where that's not a legal transition", async () => {
    const node = createRebutNode();
    await expect(node(buildState({ claimStatus: "draft" }))).rejects.toThrow(IllegalTransitionError);
  });
});
