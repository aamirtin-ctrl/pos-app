// The one rule that keeps the system-wide shortcut from making the Mac unusable.
//
// main/index.ts owns the globalShortcut registration, but it calls app.setPath() at
// module scope, so it cannot be imported without booting Electron. The pure check lives
// in main/ipc.ts instead — that file has no module-scope Electron access — which is why
// this suite imports it from there.

import { describe, it, expect } from "vitest";
import {
  validateAccelerator,
  DEFAULT_GLOBAL_HOTKEY,
  GLOBAL_HOTKEY_KEY,
} from "../main/ipc.ts";

/** The normalized accelerator, or null when the input was rejected. */
const ok = (acc: string): string | null => {
  const r = validateAccelerator(acc);
  return r.ok ? r.accelerator : null;
};
const why = (acc: string): string => {
  const r = validateAccelerator(acc);
  return r.ok ? "" : r.error;
};

describe("defaults", () => {
  // Asserted as properties, not as a literal: which chord ships is a product call that
  // can move (the owner asked for Fn+Control, which macOS cannot bind), but "it must be
  // a real chord, and Shift can never be carrying it alone" is the safety rule that
  // makes a system-wide shortcut safe to hold at all.
  it("ships an accelerator that passes its own validation, unchanged", () => {
    expect(ok(DEFAULT_GLOBAL_HOTKEY)).toBe(DEFAULT_GLOBAL_HOTKEY);
  });
  it("ships a real chord — never a bare key, never Shift-only", () => {
    const parts = DEFAULT_GLOBAL_HOTKEY.split("+");
    const mods = parts.slice(0, -1);
    expect(mods.length).toBeGreaterThan(0);
    expect(mods.some((m) => m !== "Shift")).toBe(true);
  });
  it("persists under the setting key the renderer reads", () => {
    expect(GLOBAL_HOTKEY_KEY).toBe("global_hotkey");
  });
  // He asked for Fn+Control. Fn is unbindable, so the half of the request that CAN be
  // honoured is Control — losing it silently while telling him "Fn isn't possible" would
  // read as the whole thing being ignored.
  it("keeps the Control the owner actually asked for", () => {
    expect(DEFAULT_GLOBAL_HOTKEY.split("+").slice(0, -1)).toContain("Control");
  });
  // Bare Control+Space is what macOS hands to input-source switching on most keyboards;
  // shipping it would mean the shortcut appears registered and never fires for him.
  it("does not ship the input-source chord macOS usually owns", () => {
    expect(DEFAULT_GLOBAL_HOTKEY).not.toBe("Control+Space");
  });
});

describe("validateAccelerator — accepts", () => {
  it("takes a Command+Shift chord", () => {
    expect(ok("CommandOrControl+Shift+A")).toBe("CommandOrControl+Shift+A");
  });
  it("takes a Control+Alt chord", () => {
    expect(ok("Control+Alt+Space")).toBe("Control+Alt+Space");
    expect(ok("Control+Alt+A")).toBe("Control+Alt+A");
  });
  // Option is the macOS name for the same physical key Electron calls Alt; Settings
  // tells him to use "Option", so typing it must not be rejected.
  it("takes Option as a spelling of Alt", () => {
    expect(ok("Control+Option+Space")).toBe("Control+Option+Space");
  });
  it("takes a single non-shift modifier with a named key", () => {
    expect(ok("Alt+Space")).toBe("Alt+Space");
  });
  it("takes a two-modifier chord", () => {
    expect(ok("CommandOrControl+Alt+V")).toBe("CommandOrControl+Alt+V");
  });
  it("takes function keys, digits and punctuation", () => {
    expect(ok("Control+F5")).toBe("Control+F5");
    expect(ok("Command+Shift+7")).toBe("Command+Shift+7");
    expect(ok("Alt+/")).toBe("Alt+/");
    expect(ok("CommandOrControl+Return")).toBe("CommandOrControl+Return");
  });
});

describe("validateAccelerator — rejects", () => {
  it("rejects a Shift-only chord, and says why", () => {
    expect(ok("Shift+A")).toBeNull();
    expect(why("Shift+A")).toMatch(/Shift alone is not a safe global modifier/);
    expect(why("Shift+A")).toMatch(/capital letter/);
  });
  it("rejects Shift-only however many times Shift appears", () => {
    expect(ok("Shift+Shift+A")).toBeNull();
  });
  it("rejects a bare key", () => {
    expect(ok("A")).toBeNull();
    expect(why("A")).toMatch(/no modifier/);
  });
  it("rejects empty and whitespace-only input", () => {
    expect(ok("")).toBeNull();
    expect(ok("   ")).toBeNull();
    expect(ok("\t\n ")).toBeNull();
    expect(why("")).toMatch(/Enter a shortcut/);
  });
  it("rejects a nonsense key name", () => {
    expect(ok("CommandOrControl+Flurb")).toBeNull();
    expect(why("CommandOrControl+Flurb")).toMatch(/Flurb/);
    expect(ok("CommandOrControl+Shift+Wibble")).toBeNull();
  });
  it("rejects Fn in either slot, and explains rather than listing modifiers", () => {
    for (const acc of ["Fn+Control", "Control+Fn", "fn+shift+a", "Globe+Space"]) {
      expect(ok(acc)).toBeNull();
      expect(why(acc)).toMatch(/Fn \(the Globe key\)/);
    }
  });
  it("rejects an unknown modifier", () => {
    expect(ok("Hyper+A")).toBeNull();
    expect(why("Hyper+A")).toMatch(/not a modifier/);
  });
  it("rejects a chord that never reaches a key", () => {
    expect(ok("CommandOrControl+Shift")).toBeNull();
    expect(why("CommandOrControl+Shift")).toMatch(/is a modifier, not a key/);
  });
  it("rejects empty segments rather than guessing", () => {
    expect(ok("CommandOrControl++")).toBeNull();
    expect(ok("+A")).toBeNull();
    expect(why("CommandOrControl++")).toMatch(/empty part/);
  });
});

describe("validateAccelerator — normalization", () => {
  it("normalizes case", () => {
    expect(ok("commandorcontrol+shift+a")).toBe("CommandOrControl+Shift+A");
    expect(ok("ALT+SPACE")).toBe("Alt+Space");
  });
  it("normalizes spacing", () => {
    expect(ok("  CommandOrControl + Shift + A  ")).toBe("CommandOrControl+Shift+A");
    expect(ok("Alt +   space")).toBe("Alt+Space");
  });
  it("normalizes modifier aliases to their long spelling", () => {
    expect(ok("CmdOrCtrl+Shift+A")).toBe("CommandOrControl+Shift+A");
    expect(ok("cmd+shift+a")).toBe("Command+Shift+A");
    expect(ok("ctrl+alt+delete")).toBe("Control+Alt+Delete");
  });
  it("is idempotent — a normalized accelerator validates to itself", () => {
    for (const acc of ["CommandOrControl+Shift+A", "Alt+Space", "CommandOrControl+Alt+V"]) {
      expect(ok(ok(acc)!)).toBe(acc);
    }
  });
});
