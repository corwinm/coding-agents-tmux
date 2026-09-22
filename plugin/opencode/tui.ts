import { Plugin } from "@opencode/plugin/tui";

import { setupPanePlugin } from "./state.ts";

export default Plugin.define({
  id: "coding-agents-tmux",
  setup: setupPanePlugin,
});
