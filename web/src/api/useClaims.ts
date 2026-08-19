import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client.js";
import type { ApprovalAction, ClaimDetail, ClaimsListResponse, PostalPackResult } from "./types.js";

export function useClaims() {
  return useQuery({
    queryKey: ["claims"],
    queryFn: () => apiClient.get<ClaimsListResponse>("/claims"),
  });
}

export function useClaim(claimId: string | undefined) {
  return useQuery({
    queryKey: ["claims", claimId],
    queryFn: () => apiClient.get<ClaimDetail>(`/claims/${claimId}`),
    enabled: Boolean(claimId),
  });
}

export function useApproveClaim(claimId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: ApprovalAction; editedText?: string }) =>
      apiClient.post<ClaimDetail>(`/claims/${claimId}/approval`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["claims"] });
    },
  });
}

export function useSendPostalPack(claimId: string | undefined) {
  return useMutation({
    mutationFn: () => apiClient.post<PostalPackResult>(`/claims/${claimId}/postal-pack`),
  });
}
