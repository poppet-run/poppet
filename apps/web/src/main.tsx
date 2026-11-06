/** @jsxImportSource preact */
import { render } from "preact";

import { App } from "./app/app";

const root = document.getElementById("app");

if (root) render(<App />, root);
