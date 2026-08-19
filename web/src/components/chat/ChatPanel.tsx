import { useEffect, useRef, useState } from "react";
import { useChatHistory, useSendMessage } from "../../api/useChat.js";
import { ApiError } from "../../api/client.js";
import { openOauthPopup } from "../oauth/openOauthPopup.js";
import { MessageBubble } from "./MessageBubble.js";
import { OauthConnectBubble } from "./OauthConnectBubble.js";
import { ChatInput } from "./ChatInput.js";
import type { WebAction } from "../../api/types.js";

interface PendingOauthBubble {
  provider: "gmail" | "outlook";
  authorizationUrl: string;
  blocked: boolean;
}

export function ChatPanel() {
  const history = useChatHistory();
  const sendMessage = useSendMessage();
  const [pendingOauth, setPendingOauth] = useState<PendingOauthBubble | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Shown immediately on send, before the real turn round-trips — otherwise
  // the user's own message doesn't appear until the assistant's reply comes
  // back, which reads as if nothing happened. Cleared once the refetched
  // history contains this exact turn among the entries appended SINCE this
  // send (turnCountBeforeSend), not just as the history's last entry — the
  // backend appends the user turn and the assistant's reply together in one
  // write (session.ts), so by the time a refetch lands, the last turn is
  // already the assistant's reply, not this one. Checking "last entry only"
  // left this permanently unset for every send, so the optimistic bubble
  // never disappeared — it just sat there as an apparent duplicate under the
  // real reply. Anchoring on turnCountBeforeSend (rather than matching this
  // text anywhere in history) also avoids a short reply like "yes" — which
  // legitimately repeats across a conversation (confirming more than one
  // thing) — matching a stale, unrelated earlier turn and clearing too soon.
  const [outgoing, setOutgoing] = useState<{ text: string; turnCountBeforeSend: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history.data?.turns.length, outgoing, sendMessage.isPending]);

  useEffect(() => {
    if (!outgoing) return;
    const turns = history.data?.turns ?? [];
    const newTurns = turns.slice(outgoing.turnCountBeforeSend);
    if (newTurns.some((t) => t.role === "user" && t.content === outgoing.text)) {
      setOutgoing(null);
    }
  }, [history.data, outgoing]);

  function handleSend(text: string) {
    setErrorText(null);
    setPendingOauth(null);
    setOutgoing({ text, turnCountBeforeSend: history.data?.turns.length ?? 0 });
    sendMessage.mutate(text, {
      onSuccess: (response) => {
        const oauthAction = response.actions.find((a): a is WebAction & { type: "oauth_popup" } => a.type === "oauth_popup");
        if (oauthAction) {
          const { blocked } = openOauthPopup(oauthAction.authorizationUrl);
          setPendingOauth({ provider: oauthAction.provider, authorizationUrl: oauthAction.authorizationUrl, blocked });
        }
      },
      onError: (error) => {
        setOutgoing(null);
        setErrorText(
          error instanceof ApiError && error.status === 429
            ? "The assistant is rate-limited right now — try again shortly."
            : "Something went wrong sending that. Try again.",
        );
      },
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.6rem", padding: "0.25rem" }}
      >
        {history.isLoading && <p style={{ color: "var(--text-secondary)" }}>Loading conversation…</p>}
        {history.data?.turns
          // "system" turns are backend-injected context (e.g. the note that
          // resumes a conversation once a connected inbox finishes OAuth) —
          // never something the user typed, so never shown as if they had.
          .filter((turn) => turn.role !== "system")
          .map((turn, i) => <MessageBubble key={i} turn={turn} />)}
        {outgoing && <MessageBubble turn={{ role: "user", content: outgoing.text }} />}
        {sendMessage.isPending && (
          <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", padding: "0 0.2rem" }}>Thinking…</div>
        )}
        {pendingOauth && (
          <OauthConnectBubble
            provider={pendingOauth.provider}
            authorizationUrl={pendingOauth.authorizationUrl}
            blocked={pendingOauth.blocked}
          />
        )}
        {errorText && <p style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{errorText}</p>}
      </div>
      <div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}>
        <ChatInput disabled={sendMessage.isPending} onSend={handleSend} />
      </div>
    </div>
  );
}
