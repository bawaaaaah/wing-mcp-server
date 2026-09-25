import type { JSX } from "react";
import { Route, Routes } from "react-router-dom";
import { TokenGate } from "./auth/TokenGate.js";
import { Layout } from "./components/Layout.js";
import { ConnectGuidePage } from "./pages/ConnectGuidePage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { WingPage } from "./pages/WingPage.js";

export function App(): JSX.Element {
  return (
    <TokenGate>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/wing" element={<WingPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/connect" element={<ConnectGuidePage />} />
        </Routes>
      </Layout>
    </TokenGate>
  );
}
