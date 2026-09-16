# Architecture

## Why this split exists

Through late 2026, the entire app — every view, every admin tool, every bit of
CSS — lived in one `index.html` file with a single ~2,500-line inline
`<script>` block. That's simple to deploy (still is - see below), but it means
any change, however small, means reading through thousands of lines of
unrelated code to find the right spot, whether you're a person or an AI
assistant.

This split reorganizes that same code into `styles.css` plus fourteen
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

**All 14 files in `js/` execute as if they were still one script.**

Classic (non-`type="module"`) `<script>` tags on the same page share one
global scope. A `function`, `const`, or `let` declared in `js/03-...js` is
just as visible to code in `js/09-...js` as if they'd always been in the same
file - because, until this split, they were. There is no `import`/`export`
anywhere in this codebase, and nothing needs one: every function and every
piece of shared state (`window.ss_state`, `db`, `auth`, `currUser()`, etc.) is
a plain global, reachable from any file, in either direction.

This means:
- You can call a function defined in a *later*-loading file from an *earlier*
  one, as long as the call happens later too (e.g. inside a `setTimeout` or a
  real user-triggered event like a click) - a real DOM event can't fire until
  the user acts, which is always well after every file has loaded.
- **The one case that is genuinely dangerous, and the reason `js/13-init.js`
  loads dead last:** a `<script>` tag that registers an **async
  callback backed by a Promise** (Firebase's `onAuthStateChanged`, in this
  app) is not safe just because "it fires later." Browsers run a microtask
  checkpoint after *each* `<script>` tag finishes executing - not just once
  at the very end of the page - and Firebase can resolve that very first
  callback as a microtask almost immediately (e.g. "no cached session," which
  needs no network round-trip). That means the callback can fire in the gap
  between two `<script>` tags, before later files have loaded - which is
  exactly what happened during this split: `renderEvents()` (defined in
  `js/07-...js`) was thrown as `ReferenceError: renderEvents is not defined`
  because the auth callback fired before `js/07` had loaded. The fix was to
  move the `auth.onAuthStateChanged(...)` registration itself into its own
  file (`js/13-init.js`) that loads **after every other file**, so no matter
  how fast it resolves, everything it might call already exists. Plain
  `setTimeout`s and real user-input event handlers don't have this problem -
  only Promise-driven callbacks registered by a library do.
- Every other top-level (not-inside-a-function) statement in the app only
  calls things already defined earlier in the *same* file, so it's safe
  regardless of the other files' order - see the full list in
  [FILE_GUIDE.md](FILE_GUIDE.md#load-order-rules). If you add a new
  top-level statement that registers a Promise-based callback (another
  Firebase listener, a `fetch().then(...)`, etc.), apply the same rule:
  either move it into `js/13-init.js`, or make sure it truly only touches
  things defined earlier in its own file.

## Directory layout

```
.
├── index.html              # Markup only now - <head> links styles.css, </body> loads js/*.js in order
├── styles.css              # Everything that used to be the inline <style> block, verbatim
├── js/
│   ├── 00-loading-mascot.js
│   ├── 01-firebase-init.js
│   ├── ...                 # see FILE_GUIDE.md for the full list and what's in each
│   ├── 12-banlist-chat-misc.js
│   └── 13-init.js           # Loads LAST on purpose - see the load-order note below
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
2. The original `<script>` block was cut into pieces at clean boundaries
   (blank lines between top-level sections - never inside a function), one
   file per feature area.
3. **Every** resulting file was independently checked to parse as valid
   JavaScript on its own (catching any accidental cut through the middle of a
   function or object).
4. All resulting files, reassembled in their original relative order, were
   diffed against the original inline script and confirmed **byte-for-byte
   identical** - same for `styles.css` against the original `<style>` block.
5. The resulting `index.html` was diffed against the pre-split version and
   confirmed to touch *only* the `<style>`/`<script>` regions - no markup,
   text, class names, ids, or attributes changed anywhere.
6. The split app was loaded in a browser and smoke-tested (login screen,
   admin console tabs, event detail/positions rendering, the announcement
   banner) to confirm it renders and behaves identically to the single-file
   version.

Step 6 is what caught the one real issue this split introduced: the very
first smoke test after cutting the script into 13 files threw
`ReferenceError: renderEvents is not defined` - a genuine race, not a false
alarm, caused by exactly the Promise-callback-timing hazard described above.
Byte-for-byte content equality (step 4) proves *what* code exists is
unchanged; it does not prove *when* it runs relative to other files is
unchanged, which is precisely where a single-file app and a multi-file one
can diverge. The fix was extracting `js/13-init.js` to load last (see above).
**This is why step 6 - actually running the app, more than once, and reading
the console - is not optional**, even when steps 1-5 all pass.

If a future change needs to add code, add it to whichever file in
[FILE_GUIDE.md](FILE_GUIDE.md) already covers that feature - there's no need
to create new files for ordinary feature work.
