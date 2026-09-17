import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Service-worker update registration now lives inside App.jsx (see
// useSWUpdate) so it can surface as a normal in-app banner instead of a
// native window.confirm() — see the comment on useSWUpdate for why that
// dialog was a real risk of an installed PWA looking frozen/blank.

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
