# Popup Tab Switcher

A VS Code-style tab switcher for Obsidian. Press **Ctrl+Tab** to open a popup listing your open tabs in most-recently-used order. Keep holding Ctrl and press Tab to cycle; release Ctrl to open the selected tab. Shift+Tab cycles backwards. Enter confirms, Escape cancels.

## Install (development)

1. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/popup-tab-switcher/`.
2. Enable "Popup Tab Switcher" in Settings → Community plugins.

## Build

```bash
npm install
npm run build
```