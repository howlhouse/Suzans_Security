# File Guide

One-line purpose and key top-level functions/state for every file in `js/`,
in load order (the order they're `<script src>`'d in `index.html`). Read
[ARCHITECTURE.md](ARCHITECTURE.md) first if you haven't - it explains why
load order mostly doesn't matter for anything except the handful of cases
called out at the bottom of this doc.

Every function listed below is a plain global, callable from any other file.

| # | File | Purpose |
|---|---|---|
| 00 | `00-loading-mascot.js` | Decorative, currently-unused chroma-key video effect for the loading screen. No-ops if the video/canvas elements aren't present (they aren't, right now). |
| 01 | `01-firebase-init.js` | Firebase project config and the three top-level handles (`db`, `auth`, plus the `firebaseConfig` object) everything else in the app uses to talk to Firestore/Auth. |
| 02 | `02-notifications.js` | Browser `Notification` permission + dispatch (`notifyUser`), and the client-side "shift starts in 90 minutes" reminder scheduler. |
| 03 | `03-state-and-persistence.js` | The global in-memory store (`window.ss_state`, `getDB`), the Firestore write/delete helpers everything else calls (`saveDoc`, `deleteDoc`, `logAction`), and the new-user email notice sent via the Firebase Trigger Email extension. |
| 04 | `04-bootstrap.js` | The loading-screen progress bar (`bumpProgress`, `dropLoadingScreen`), `initialLoad()` (one authoritative server read of every collection + one-time DB seed), `attachRealtimeListeners()` (the Firestore `onSnapshot` listeners that keep the app live), and `refreshGlobalUI()` - the function every realtime update funnels through to re-render whichever view is currently open. The *registration* of the auth handshake that calls into these lives in `13-init.js`, not here - see the load order note below. |
| 05 | `05-catalog-and-announcements.js` | The tag and rank/role catalogs (`DEFAULT_TAGS`/`DEFAULT_ROLES`, `tagToId`/`roleToId`), shift-position slot math (`eventOpenSlots`, `positionFilled`), event auto-archiving (`runAutoArchiveSweep`, `archiveEvent`, `restoreEvent`, `renderArchive`), and the whole System > Announcement Banner feature (preview, save, live toggle, expiry sweep). |
| 06 | `06-auth-and-shell.js` | `currUser()`, sign-in/registration (`handleAuth`, `toggleAuth`, `friendlyAuthError`, `forgotPassword`, `logout`), session validation (`validateSession`), the Terms & Conditions scroll-gate, the user-name and "Add to Calendar" header dropdowns, unread-chat-badge tracking, and `switchView()` - the function that shows/hides every top-level view section. |
| 07 | `07-events-and-details.js` | The Events feed tiles (`renderEvents`), the full event detail page (`renderEventDetail`) including the roster, Available Positions list, and per-shift chat, plus claiming/dropping a shift or a specific position (`toggleSignUp`, `claimPosition`). |
| 08 | `08-calendar.js` | The month-grid Calendar tab (`renderCal`, `changeMonth`). |
| 09 | `09-admin-events.js` | Command Center > Events: the PIN gate (`promptAdminPin`), the whole staged-draft shift editor (create/edit/save a posting, positions, timeline, roster, promoter links - everything prefixed `draft*`), and the admin tab-switcher (`switchAdmin`). This is the largest file - it's one cohesive feature (the event editor), not several. |
| 10 | `10-admin-ops.js` | The rest of Command Center: Chat Management (channels/messages), the Tag and Rank/Role catalog managers, Logs, and the Users table + add/edit/delete-user modal (including the admin-creates-an-account flow). |
| 11 | `11-settings-and-calendar.js` | The per-user Settings tab (profile, password, notification prefs, delete-my-account), My Shifts, the Promoter/Contact directory and its admin editor, and "Add to Calendar" (.ics / Google Calendar link generation). |
| 12 | `12-banlist-chat-misc.js` | The Ban List (open to all signed-in users), Team Chat (`renderChat`, `sendChat`, channel switching, file attachments), the About modal pages, the first-open Welcome popup, the generic `closeModal()` helper, and the admin PIN-change form. |
| 13 | `13-init.js` | **Loads dead last, deliberately.** Registers the 20-second hard-failsafe `setTimeout` and the `auth.onAuthStateChanged(...)` handshake that actually starts the app (loads the signed-in user's profile and calls `initialLoad()`, or shows the sign-in modal). This is intentionally the *only* thing in this file - see [Load order rules](#load-order-rules) for why it has to load after everything else. |

## Load order rules

Per [ARCHITECTURE.md](ARCHITECTURE.md), load order only matters for code that
runs *immediately* (not inside a function) when its file loads - and even
then, mostly only for one specific kind of statement. Here is every
top-level statement in the app, and why each one is safe:

| File | Statement | Why it's safe |
|---|---|---|
| `00-loading-mascot.js` | `(function initLoadingMascot() {...})();` | Fully self-contained IIFE; touches nothing outside this file. |
| `01-firebase-init.js` | `firebase.initializeApp(firebaseConfig);` | Uses only the `firebaseConfig` object defined earlier in this same file. |
| `06-auth-and-shell.js` | Two `document.addEventListener('click', ...)` calls (user menu / calendar-menu dismiss-on-outside-click) | Registers listeners; the callback bodies only call functions already defined earlier in this same file, and only run on a later real click - a genuine DOM input event, which cannot fire until the user acts, long after every file has loaded. |
| `06-auth-and-shell.js` | `populateTermsContainers();` | Calls a function defined earlier in this same file, which only touches DOM elements that already exist (the whole `<body>` is parsed before any `<script>` tag runs). |
| `13-init.js` | `setTimeout(() => { ... dropLoadingScreen(); }, HARD_LOAD_TIMEOUT_MS);` and `auth.onAuthStateChanged(async (user) => {...});` | **This is the dangerous case** - see below. Both are placed in the last-loading file specifically so it's safe. |

### Why `auth.onAuthStateChanged` gets special treatment

A real click event, or a plain `setTimeout`, cannot fire until well after the
whole page (all 14 files) has finished loading - there's no way for the
browser to generate a click before the user acts, or to fire a 20-second
timer 0ms after it's registered.

A **Promise-driven callback from a library** is different, and this
distinction is exactly what broke during this split the first time: browsers
run a "microtask checkpoint" after *every single* `<script>` tag finishes
executing, not just once at the end of the whole page. Firebase's
`onAuthStateChanged` can resolve its very first callback invocation as a
microtask almost immediately - e.g. "there's no cached session," which needs
no network round-trip to determine. When `js/04-bootstrap.js` used to
register that listener directly, the callback could fire in the gap between
`js/04` finishing and `js/05` (or `js/07`, etc.) even starting to load -
which is exactly what produced `ReferenceError: renderEvents is not defined`
the first time this was smoke-tested.

The fix: `js/13-init.js` is the **only** file that registers this listener
(and the related hard-failsafe timer), and it is the **last** `<script>` tag
in `index.html`. By the time it runs, all 13 other files have already
finished executing - so no matter how fast Firebase resolves the callback,
every function it might call already exists.

**If you ever add a new top-level statement that registers a Promise-backed
callback** (another Firebase listener, a bare `somePromise.then(...)` not
inside a function, etc.), it needs the same treatment: either move it into
`js/13-init.js`, or make very sure it only calls things defined earlier in
its own file. A plain `setTimeout`, a `document.addEventListener`, or a
function *definition* (as opposed to an immediate call) never has this
problem - only an already-resolved-or-fast-resolving Promise callback,
registered at the top level, does.
