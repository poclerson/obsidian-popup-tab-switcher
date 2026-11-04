import { Modal, Plugin, WorkspaceLeaf, setIcon } from "obsidian";

interface TabSwitcherPluginSettings {
  // reserved for future
}

const DEFAULT_SETTINGS: TabSwitcherPluginSettings = {};

class PopupTabSwitcherPlugin extends Plugin {
  settings: TabSwitcherPluginSettings = { ...DEFAULT_SETTINGS };
  mru: WorkspaceLeaf[] = [];
  picker: TabPickerModal | null = null;
  private previousSwitcherHotkeys: any = null;
  private previousWasCustom = false;
  private hadSwitcherHotkey = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Seed MRU with whatever leaves exist right now (best-effort order).
    const seed: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => seed.push(leaf));
    const active = this.app.workspace.getMostRecentLeaf();
    if (active) {
      this.mru = [active, ...seed.filter((l) => l !== active)];
    } else {
      this.mru = seed;
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) this.touchLeaf(leaf);
      })
    );

    this.addCommand({
      id: "open-tab-picker",
      name: "Open tab picker",
      hotkeys: [{ modifiers: ["Ctrl"], key: "Tab" }],
      callback: () => this.openPicker(),
    });

    // Free up Ctrl+Tab from Obsidian's built-in note switcher so it opens our picker.
    this.overrideSwitcherHotkey();

    // Also expose a plain command without forced hotkey for command palette.
    this.addCommand({
      id: "switch-to-next-tab",
      name: "Switch to next tab (MRU)",
      callback: () => {
        const leaves = this.getEditorLeaves();
        if (leaves.length < 2) return;
        const target = leaves[1] ?? leaves[0];
        void this.app.workspace.setActiveLeaf(target, { focus: true });
      },
    });
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<TabSwitcherPluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    this.restoreSwitcherHotkey();
    if (this.picker) {
      this.picker.close();
      this.picker = null;
    }
  }

  private overrideSwitcherHotkey(): void {
    const hm: any = (this.app as any).hotkeyManager;
    if (!hm || typeof hm.getHotkeys !== "function") return;
    const effective = hm.getHotkeys("switcher:open") || hm.getDefaultHotkeys?.("switcher:open") || [];
    const filtered = (effective || []).filter((h: any) => {
      const mods = (h.modifiers || []).map((m: string) => String(m).toLowerCase());
      const key = String(h.key || "").toLowerCase();
      const isCtrlTab = key === "tab" && mods.includes("ctrl") && !mods.includes("meta") && !mods.includes("alt") && !mods.includes("shift");
      return !isCtrlTab;
    });
    if (filtered.length !== (effective || []).length) {
      const custom = hm.getHotkeys("switcher:open");
      this.previousSwitcherHotkeys = custom;
      this.previousWasCustom = custom !== undefined;
      this.hadSwitcherHotkey = true;
      hm.setHotkeys("switcher:open", filtered);
    }
  }

  private restoreSwitcherHotkey(): void {
    if (!this.hadSwitcherHotkey) return;
    const hm: any = (this.app as any).hotkeyManager;
    if (!hm || typeof hm.setHotkeys !== "function") return;
    if (this.previousWasCustom) {
      hm.setHotkeys("switcher:open", this.previousSwitcherHotkeys ?? []);
    } else {
      hm.removeHotkeys?.("switcher:open");
    }
    this.hadSwitcherHotkey = false;
  }

  touchLeaf(leaf: WorkspaceLeaf): void {
    this.mru = this.mru.filter((l) => l !== leaf);
    this.mru.unshift(leaf);
  }

  isEditorLeaf(leaf: WorkspaceLeaf): boolean {
    const view: any = leaf.view;
    if (!view) return false;
    // FileView-backed tabs (markdown, canvas, images, pdf, ...).
    if (typeof view.file !== "undefined") return true;
    // Also include leaves that live in the main workspace root (center tabs),
    // not in the sidedocks, so non-file editor views (e.g. graph) are covered.
    try {
      let item: any = leaf;
      let inSidedock = false;
      while (item) {
        const name = item?.constructor?.name ?? "";
        if (name.includes("Sidedock")) { inSidedock = true; break; }
        if (!item.parent) break;
        item = item.parent;
      }
      if (inSidedock) return false;
      return true;
    } catch {
      return false;
    }
  }

  getEditorLeaves(): WorkspaceLeaf[] {
    const current: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (this.isEditorLeaf(leaf)) current.push(leaf);
    });

    const set = new Set(current);
    // Clean stale entries.
    this.mru = this.mru.filter((l) => set.has(l));

    // Seed if empty.
    if (this.mru.length === 0) {
      this.mru = [...current];
    }

    const ordered = this.mru.filter((l) => set.has(l));
    for (const l of current) {
      if (!ordered.includes(l)) ordered.push(l);
    }
    return ordered;
  }

  openPicker(): void {
    if (this.picker) {
      // Cycling is handled by the modal's key scope.
      return;
    }
    const leaves = this.getEditorLeaves();
    if (leaves.length === 0) return;
    this.picker = new TabPickerModal(this.app, this);
    this.picker.open();
  }
}

class TabPickerModal extends Modal {
  private plugin: PopupTabSwitcherPlugin;
  private leaves: WorkspaceLeaf[] = [];
  private items: HTMLElement[] = [];
  private selectedIndex = 0;
  private committed = false;
  private openedAt = 0;
  private keyupHandler: ((e: KeyboardEvent) => void) | null = null;
  private listEl: HTMLElement | null = null;

  constructor(app: any, plugin: PopupTabSwitcherPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.openedAt = (typeof performance !== "undefined") ? performance.now() : Date.now();
    this.modalEl.addClass("popup-tab-switcher-modal");
    // Hide the default title row to look like a quick picker.
    this.titleEl.style.display = "none";

    this.contentEl.empty();
    this.leaves = this.plugin.getEditorLeaves();
    if (this.leaves.length === 0) {
      this.close();
      return;
    }

    // VS Code: Ctrl+Tab highlights the next (2nd) item in MRU order.
    this.selectedIndex = this.leaves.length > 1 ? 1 : 0;

    this.listEl = this.contentEl.createDiv({ cls: "pts-list" });

    this.leaves.forEach((leaf, i) => {
      const item = this.listEl!.createDiv({ cls: "pts-item" });

      const iconEl = item.createSpan({ cls: "pts-icon" });
      try {
        setIcon(iconEl, leaf.getIcon());
      } catch {
        // ignore
      }

      const titleEl = item.createSpan({ cls: "pts-title" });
      titleEl.setText(leaf.getDisplayText());

      const view: any = leaf.view;
      if (view && view.file && typeof view.file.path === "string") {
        const pathEl = item.createSpan({ cls: "pts-path" });
        pathEl.setText(view.file.path);
      }

      item.addEventListener("click", () => {
        this.selectedIndex = i;
        this.updateSelection();
        this.commit();
      });
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.updateSelection();
      });

      this.items.push(item);
    });

    this.updateSelection();

    // Key handling: Tab / Shift+Tab cycle; arrows; Enter commit; Escape close.
    this.scope.register(null, "Tab", (evt) => {
      const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
      // Ignore the very first Tab that opened the picker.
      if (now - this.openedAt > 60) {
        if (evt.shiftKey) this.cycle(-1);
        else this.cycle(1);
      }
      evt.preventDefault();
      return false;
    });
    this.scope.register(null, "ArrowDown", (evt) => {
      this.cycle(1);
      evt.preventDefault();
      return false;
    });
    this.scope.register(null, "ArrowUp", (evt) => {
      this.cycle(-1);
      evt.preventDefault();
      return false;
    });
    this.scope.register(null, "Enter", (evt) => {
      this.commit();
      evt.preventDefault();
      return false;
    });

    // Commit when Ctrl is released (VS Code behavior).
    this.keyupHandler = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        this.commit();
      }
    };
    window.addEventListener("keyup", this.keyupHandler!, true);
  }

  cycle(delta: number): void {
    if (this.leaves.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + delta + this.leaves.length) % this.leaves.length;
    this.updateSelection();
  }

  updateSelection(): void {
    this.items.forEach((el, i) => {
      el.toggleClass("is-selected", i === this.selectedIndex);
    });
    const sel = this.items[this.selectedIndex];
    if (sel) {
      try {
        sel.scrollIntoView({ block: "nearest" });
      } catch {
        // ignore
      }
    }
  }

  commit(): void {
    if (this.committed) return;
    this.committed = true;
    const leaf = this.leaves[this.selectedIndex];
    this.close();
    if (leaf) {
      void this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
  }

  onClose(): void {
    if (this.keyupHandler) window.removeEventListener("keyup", this.keyupHandler, true);
    this.plugin.picker = null;
    this.contentEl.empty();
    this.items = [];
  }
}

export default PopupTabSwitcherPlugin;
