// React bindings for the vanilla Zustand store. Components call these hooks to
// subscribe to narrow slices; the WebSocket layer writes to the SAME vanilla
// store via setState outside React render (see store.ts and ws/client.ts).
//
// We use zustand's useStore binding with the vanilla store instance so that the
// store itself has no React dependency and can be mutated at high frequency
// without forcing a render per message. Components only re-render when the slice
// they select actually changes.

import { useStore } from "zustand";
import { officeStore } from "./store";
import type { StoreState } from "./store";

// useOffice subscribes to a selected slice of the store.
export function useOffice<T>(selector: (s: StoreState) => T): T {
  return useStore(officeStore, selector);
}

// A few convenience selectors used across the UI.
export const selectConnected = (s: StoreState) => s.connected;
export const selectOrder = (s: StoreState) => s.order;
export const selectOffice = (s: StoreState) => s.office;
export const selectError = (s: StoreState) => s.lastError;
export const selectSelectedAgentId = (s: StoreState) => s.selectedAgentId;
