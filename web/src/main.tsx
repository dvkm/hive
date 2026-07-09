import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { StoreProvider } from "./lib/store";
import { LightboxProvider } from "./lib/lightbox";
import App from "./App";
import "./styles.css";

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
