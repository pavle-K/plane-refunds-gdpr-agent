import { Annotation } from "@langchain/langgraph";

// Placeholder state shape for Stage 0 — proves graph wiring + checkpointing only.
// Replaced with the real claim-pipeline state (booking, eligibility, draft, etc.,
// per CLAUDE.md §2.2) once Stage 2 implements the real nodes.
export const GraphState = Annotation.Root({
  stepsCompleted: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

export type GraphStateType = typeof GraphState.State;
