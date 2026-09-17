import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Service-worker update registration now lives inside App.jsx (see
// useSWUpdate) so it can surface as a normal in-app banner instead of
// reloading immediately or using window.confirm() — see the comment on
// useSWUpdate for why both were a real risk.

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
