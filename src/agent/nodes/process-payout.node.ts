import { interrupt } from "@langchain/langgraph";
import type { GraphStateType } from "../state.js";
import type { PaymentsProvider } from "../../providers/payments/payments.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import { splitPayout } from "../../domain/money/split.js";
import { applyTransition } from "../../domain/claim/state-machine.js";
import { DEFAULT_COMMISSION_RATE_BASIS_POINTS } from "../../config/constants.js";

export interface ProcessPayoutNodeDeps {
  payments: PaymentsProvider;
  auditLog: AuditLog;
}

export interface PaymentReceivedPayload {
  claimId: string;
  awaiting: "payment_confirmation";
}

export interface PaymentReceivedEvent {
  receivedAmountCents: number;
  connectedAccountId: string;
}

/**
 * "Trigger the Stripe Connect split ONCE the airline pays" (§2.2) — the waiting
 * for actual payment is this node's job, not a separate node (the plan fixes the
 * pipeline at 11 nodes). If payment hasn't been confirmed yet, this interrupts
 * exactly like human-approval/awaitResponse, resumed by a payment webhook.
 */
export function createProcessPayoutNode(deps: ProcessPayoutNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    let receivedAmountCents = state.receivedAmountCents;
    let connectedAccountId = state.connectedAccountId;

    if (receivedAmountCents === null || !connectedAccountId) {
      const event = interrupt<PaymentReceivedPayload, PaymentReceivedEvent>({
        claimId: state.claimId,
        awaiting: "payment_confirmation",
      });
      receivedAmountCents = event.receivedAmountCents;
      connectedAccountId = event.connectedAccountId;
    }

    const split = splitPayout({
      receivedAmountCents,
      currency: "EUR",
      commissionRateBasisPoints: DEFAULT_COMMISSION_RATE_BASIS_POINTS,
    });

    const transferResult = await deps.payments.transferPayout({
      claimId: state.claimId,
      connectedAccountId,
      payoutCents: split.payoutCents,
      currency: "EUR",
    });

    if (!transferResult.ok) {
      throw new Error(`processPayout: transfer failed (${transferResult.error.type}): ${transferResult.error.message}`);
    }

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "system_action",
      payload: { node: "processPayout", split, transferId: transferResult.value.transferId },
    });

    return {
      claimStatus: applyTransition(state.claimStatus, "CONFIRM_PAYOUT"),
      receivedAmountCents,
      connectedAccountId,
      payout: {
        commissionCents: split.commissionCents,
        payoutCents: split.payoutCents,
        transferId: transferResult.value.transferId,
      },
    };
  };
}
