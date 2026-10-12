# App themes

The whole app can be re-skinned from **Command Center > System > App Theme**. The choice is a
system setting (one document, `settings/theme` = `{ theme: "default" | "halloween", ... }`), so it
applies to everyone and changes live on open devices.

- **Neon Desert** (`default`) is the baseline. It has no overrides - it *is* `styles.css`.
- **Halloween** (`halloween`), **Christmas** (`christmas`) and **Thanksgiving** (`thanksgiving`) are
  blocks of overrides at the bottom of `styles.css`, keyed off `<html data-theme="...">`.
  - Halloween: orange / purple / slime green, cobwebs, spider, bats, fog.
  - Christmas: green / red / gold on evergreen, twinkling lights and falling snow.
  - Thanksgiving: harvest gold / cranberry / sage on warm brown, leaf garland and drifting leaves.

## How it works

- `js/05-catalog-and-announcements.js` (`APP_THEMES`, `getSavedTheme`, `applyTheme`, `syncTheme`,
  `renderThemeControls`, `saveTheme`). `syncTheme()` runs on every data refresh
  (`refreshGlobalUI`), but only after the `settings` collection has loaded.
- Picking a theme on the System tab is a **local preview** (`window._themeDraft`); nothing is saved
  until **Apply to everyone**. Leaving the System tab drops the preview.
- The saved theme is cached in `localStorage` (`ss_theme`) and applied by a small script in
  `index.html`'s `<head>`, so the next load paints in the right theme (login screen included)
  with no flash.
- Each theme can name one web font (`font` in `APP_THEMES`); it's only fetched while that theme is on, and the
  link is swapped when previewing between themes.
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
4. If the theme needs a web font, set `font` on its `APP_THEMES` entry (a Google Fonts family spec, e.g.
   `'Lobster'`) and add the same id/spec to the small `fonts` map in the `<head>` script in `index.html`
   (that script runs before the app, so it can't read `APP_THEMES`). The `data-theme` attribute itself is
   set for any theme id, so nothing else needs to change there.
