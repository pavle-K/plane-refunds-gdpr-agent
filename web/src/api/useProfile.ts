import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client.js";
import type { PassengerProfileResponse, SavePassengerProfileInput } from "./types.js";

const PROFILE_QUERY_KEY = ["profile"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => apiClient.get<PassengerProfileResponse>("/profile"),
  });
}

export function useSaveProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SavePassengerProfileInput) => apiClient.put<PassengerProfileResponse>("/profile", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });
}
