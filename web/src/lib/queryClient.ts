import { QueryClient } from "@tanstack/react-query";

/** One shared instance, imported directly (not just via context) — needed by
 * components/oauth/openOauthPopup.ts, which runs outside the React tree and
 * has no way to reach a context value. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
