import { Route, Routes } from "react-router-dom";
import { TokenGate } from "./auth/TokenGate.js";
import { Layout } from "./components/Layout.js";
import { ConnectGuidePage } from "./pages/ConnectGuidePage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { WingPage } from "./pages/WingPage.js";

export function App() {
  return (
    <TokenGate>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/wing" element={<WingPage />} />
          <Route path="/connect" element={<ConnectGuidePage />} />
        </Routes>
      </Layout>
    </TokenGate>
  );
}
