import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "./client.js";
import type { ChatHistoryResponse, SendMessageResponse } from "./types.js";

const HISTORY_QUERY_KEY = ["chat", "history"] as const;

export function useChatHistory() {
  return useQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => apiClient.get<ChatHistoryResponse>("/chat/history"),
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => apiClient.post<SendMessageResponse>("/chat", { text }),
    onSuccess: () => {
      // A single turn can start/advance a claim, connect an inbox, or save
      // profile fields — invalidating broadly is simpler and cheaper than
      // trying to infer from the reply text which of those actually
      // happened, and these are all small, infrequently-refetched queries.
      void queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["claims"] });
      void queryClient.invalidateQueries({ queryKey: ["email-connections"] });
      void queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
  });
}
