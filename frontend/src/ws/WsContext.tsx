// A tiny React context that exposes the singleton WsClient to the UI so control
// buttons (pause/resume/stop/stopAll/whip/office.update) can dispatch commands.
// The client itself writes incoming traffic into the vanilla store outside
// React render; this context only carries the send side.

import { createContext, useContext } from "react";
import type { WsClient } from "./client";

const WsContext = createContext<WsClient | null>(null);

export const WsProvider = WsContext.Provider;

export function useWs(): WsClient {
  const ws = useContext(WsContext);
  if (!ws) throw new Error("useWs must be used within a WsProvider");
  return ws;
}
