import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { StoreProvider } from "./lib/store";
import { LightboxProvider } from "./lib/lightbox";
import App from "./App";
import { registerServiceWorker } from "./lib/push";
import "./styles.css";

void registerServiceWorker(); // PWA install + push delivery (no-op off HTTPS)

// In the Electron app the window uses titleBarStyle:"hiddenInset", so the macOS
// traffic lights float over the top-left where the brand sits. Tag the root so
// CSS can inset the topbar past them; a plain browser tab has no traffic lights.
if (navigator.userAgent.includes("Electron")) document.documentElement.classList.add("electron");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <LightboxProvider>
          <App />
        </LightboxProvider>
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>
);
