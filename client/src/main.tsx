import { ConfigProvider, App as AntApp } from "antd";
import ptBR from "antd/locale/pt_BR";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AnalysisProvider } from "./analysis/AnalysisContext";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { extrakTheme } from "./theme/extrakTheme";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={extrakTheme} locale={ptBR}>
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <AnalysisProvider>
              <App />
            </AnalysisProvider>
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </StrictMode>
);
