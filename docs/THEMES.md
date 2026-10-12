# App themes

The whole app can be re-skinned from **Command Center > System > App Theme**. The choice is a
system setting (one document, `settings/theme` = `{ theme: "default" | "halloween", ... }`), so it
applies to everyone and changes live on open devices.

- **Neon Desert** (`default`) is the baseline. It has no overrides - it *is* `styles.css`.
- **Halloween** (`halloween`) is a block of overrides at the bottom of `styles.css`, keyed off
  `<html data-theme="halloween">`.

## How it works

- `js/05-catalog-and-announcements.js` (`APP_THEMES`, `getSavedTheme`, `applyTheme`, `syncTheme`,
  `renderThemeControls`, `saveTheme`). `syncTheme()` runs on every data refresh
  (`refreshGlobalUI`), but only after the `settings` collection has loaded.
- Picking a theme on the System tab is a **local preview** (`window._themeDraft`); nothing is saved
  until **Apply to everyone**. Leaving the System tab drops the preview.
- The saved theme is cached in `localStorage` (`ss_theme`) and applied by a small script in
  `index.html`'s `<head>`, so the next load paints in the right theme (login screen included)
  with no flash.
- The theme font (Creepster) is only fetched while the Halloween theme is on.
- PROD and DEV share one Firebase project, so the setting is shared too. Use the local preview to
  try a theme without changing it for the team.

## Adding a theme

1. Add an entry to `APP_THEMES` (label, icon, blurb, swatch colors).
2. Add an `html[data-theme="<id>"]` block to `styles.css`. Most of the app is driven by variables:
   `--bg-obsidian`, `--bg-card`, `--glass-sheet`, `--border-glass`, `--text-*`, `--danger-glow`, and
   the accents `--neon-teal` / `--neon-pink` / `--neon-saguaro` (+ `--teal-rgb`, `--pink-rgb`,
   `--green-rgb`, `--neon-teal-deep`, `--neon-pink-deep` for the `rgba(...)` and gradient uses).
   The names are historical - they just carry whatever the theme's accent colors are.
3. Optional decoration: `.watermark-pattern` (tiled background icons) and `.theme-decor`
   (`::before` / `::after` layers behind the content). Both are purely visual (`pointer-events: none`).
4. Allow the new id in the `if (t === 'halloween')` bits of the `<head>` script in `index.html`
   if it needs an early font load (otherwise the attribute alone is enough - extend that script to
   set it for any id found in `localStorage`).
