import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage.js";
import { ClaimsListPage } from "./pages/ClaimsListPage.js";
import { ClaimDetailPage } from "./pages/ClaimDetailPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { HelpPage } from "./pages/HelpPage.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/claims" element={<ClaimsListPage />} />
      <Route path="/claims/:id" element={<ClaimDetailPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/help" element={<HelpPage />} />
    </Routes>
  );
}
