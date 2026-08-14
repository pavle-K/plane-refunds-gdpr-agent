export interface NgrokTunnel {
  public_url: string;
  proto: string;
  config: { addr: string };
}

/** Queries ngrok's own local API (http://127.0.0.1:4040) for a tunnel pointed
 * at our port — lets scripts skip the "copy the ngrok URL by hand" step.
 * Returns null if ngrok isn't running or has no matching tunnel; doesn't
 * throw, since "not running yet" is an expected, normal state (e.g. while
 * scripts/dev-telegram.ts is still waiting for a tunnel it just started). */
export async function detectNgrokUrl(port: number): Promise<string | null> {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { tunnels: NgrokTunnel[] };
    const match = body.tunnels.find((t) => t.proto === "https" && t.config.addr.endsWith(`:${port}`));
    return match?.public_url ?? null;
  } catch {
    return null;
  }
}
