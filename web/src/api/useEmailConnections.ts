import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client.js";
import type { EmailConnectionsResponse } from "./types.js";

export const EMAIL_CONNECTIONS_QUERY_KEY = ["email-connections"] as const;

export function useEmailConnections() {
  return useQuery({
    queryKey: EMAIL_CONNECTIONS_QUERY_KEY,
    queryFn: () => apiClient.get<EmailConnectionsResponse>("/email-connections"),
  });
}
