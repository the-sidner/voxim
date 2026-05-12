/// <reference lib="dom" />
/**
 * Studio entry point. Mounts the Preact app into #app.
 */
import { render } from "preact";
import { App } from "./App.tsx";

const root = document.getElementById("app");
if (!root) throw new Error("studio: #app element missing from index.html");
render(<App />, root);
