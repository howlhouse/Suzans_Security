# Architecture

## Why this split exists

Through late 2026, the entire app — every view, every admin tool, every bit of
CSS — lived in one `index.html` file with a single ~2,500-line inline
`<script>` block. That's simple to deploy (still is - see below), but it means
any change, however small, means reading through thousands of lines of
unrelated code to find the right spot, whether you're a person or an AI
assistant.

This split reorganizes that same code into `styles.css` plus thirteen
`js/*.js` files grouped by feature (see [FILE_GUIDE.md](FILE_GUIDE.md)), so a
change to, say, the ban list only requires opening `js/12-banlist-chat-misc.js`
- not the whole app.

**This was a pure reorganization.** No markup, styling, or logic changed - see
[Behavior-preservation guarantee](#behavior-preservation-guarantee) below for
exactly how that was verified. If you notice *any* difference in how the app
looks or behaves compared to before this split, that's a bug in the split and
should be reported/fixed as such.

## Still no build step

This is still deployable as-is to any static host - just more files instead
of one. There's no bundler, no transpiler, no `npm install`. Every `js/*.js`
file is a plain classic (non-module) script, loaded via an ordinary
`<script src="...">` tag, exactly like the single inline block was before.
Upload the whole directory; nothing needs to be compiled first.

## The mental model: one script, cut into pieces

The single most important thing to understand about this codebase's structure:

**All 13 files in `js/` execute as if they were still one script.**

Classic (non-`type="module"`) `<script>` tags on the same page share one
global scope. A `function`, `const`, or `let` declared in `js/03-...js` is
just as visible to code in `js/09-...js` as if they'd always been in the same
file - because, until this split, they were. There is no `import`/`export`
anywhere in this codebase, and nothing needs one: every function and every
piece of shared state (`window.ss_state`, `db`, `auth`, `currUser()`, etc.) is
a plain global, reachable from any file, in either direction.

This means:
- You can call a function defined in a *later*-loading file from an *earlier*
  one, as long as the call happens later too (e.g. inside an event handler,
  a `setTimeout`, or a Firestore callback) - by the time anything actually
  *runs* after page load, all 13 files have already finished loading and
  defining their functions.
- The **only** thing load order actually controls is code that executes
  *immediately* at the top level of a file (not inside a function) - e.g. an
  IIFE, a bare `firebase.initializeApp(...)` call, or a `document.addEventListener(...)`
  registration. There are exactly a handful of these in the whole app
  (see the list in [FILE_GUIDE.md](FILE_GUIDE.md#load-order-rules)), and
  every one of them only calls into things already defined earlier in the
  *same* file - so the current file order is not load-bearing beyond "load
  them all, in this order, every time." Don't reorder the `<script>` tags in
  `index.html` without re-checking that list.

## Directory layout

```
.
├── index.html              # Markup only now - <head> links styles.css, </body> loads js/*.js in order
├── styles.css              # Everything that used to be the inline <style> block, verbatim
├── js/
│   ├── 00-loading-mascot.js
│   ├── 01-firebase-init.js
│   ├── ...                 # see FILE_GUIDE.md for the full list and what's in each
│   └── 12-banlist-chat-misc.js
├── manifest.json           # PWA manifest (unchanged)
├── sw.js                   # Service worker - now also precaches styles.css and js/*.js
├── firestore.rules         # Firestore security rules (unchanged)
├── docs/                   # You are here
│   ├── ARCHITECTURE.md
│   └── FILE_GUIDE.md
└── House_Black_Logo.png    # Brand asset (unchanged)
```

## Behavior-preservation guarantee

This split was done mechanically, not rewritten by hand, specifically so it
couldn't introduce behavior changes:

1. The original `<style>` block was extracted verbatim into `styles.css`.
2. The original `<script>` block was cut into 13 pieces at clean boundaries
   (blank lines between top-level sections - never inside a function).
3. **Every** resulting file was independently checked to parse as valid
   JavaScript on its own (catching any accidental cut through the middle of a
   function or object).
4. All 13 files, concatenated back together in load order, were diffed
   against the original inline script and confirmed **byte-for-byte
   identical** - same for `styles.css` against the original `<style>` block.
5. The resulting `index.html` was diffed against the pre-split version and
   confirmed to touch *only* the `<style>`/`<script>` regions - no markup,
   text, class names, ids, or attributes changed anywhere.
6. The split app was loaded in a browser and smoke-tested (login screen,
   admin console tabs, event detail/positions rendering, the announcement
   banner) to confirm it renders and behaves identically to the single-file
   version.

If a future change needs to add code, add it to whichever file in
[FILE_GUIDE.md](FILE_GUIDE.md) already covers that feature - there's no need
to create new files for ordinary feature work.
