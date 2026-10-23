// React entry point. Mounts the App shell into #root. The WebSocket connection
// and the vanilla Zustand store are initialized inside App so the store exists
// independently of React render.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
