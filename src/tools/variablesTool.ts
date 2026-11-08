// Variables switched on (like Section View): the tags show in the view, and a
// card with New Variable and the whole list. Tapping the view leaves the card;
// the tags stay until Variables is tapped again (or Turn Off).

import { createVariable, editVariables } from "../io/insert";
import type { AppContext, Tool } from "./tool";

export interface VariablesHost extends AppContext {
  /** Variables off: the tags go, and this card. */
  variablesOff(): void;
}

export class VariablesTool implements Tool {
  readonly id = "variables";

  constructor(private app: VariablesHost) {}

  enter(): void {
    this.app.ui.setTools([{ id: "exit", label: "Done", icon: "exit", shortcut: "Esc", run: () => this.app.setTool(null) }]);
    // The view tools stay, this one lit and pulsing (tap it again to close it).
    this.app.ui.setBottom(this.app.bottomTools());
    this.showCard();
  }

  private showCard(): void {
    const n = this.app.store.doc.variables.length;
    this.app.ui.setHint(n ? "Tap a variable's tag to change it - type a value or a formula, or drag the value. The model follows." : "No variables yet: make one, then use it in any value box (ƒx).");
    this.app.ui.showPanel({
      title: "Variables",
      items: [
        { type: "button", label: "New Variable", icon: "variableNew", primary: !n, onClick: () => void createVariable(this.app).then(() => this.showCard()) },
        ...(n ? [{ type: "button" as const, label: `All Variables (${n})`, icon: "variable" as const, onClick: () => void editVariables(this.app).then(() => this.showCard()) }] : []),
      ],
      actions: [{ id: "off", label: "Turn Off", icon: "close", run: () => this.app.variablesOff() }],
      onDone: () => this.app.setTool(null),
    });
  }

  exit(): void {
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
  }

  tap(): void {
    this.app.setTool(null);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter") {
      this.app.setTool(null);
      return true;
    }
    return false;
  }
}
