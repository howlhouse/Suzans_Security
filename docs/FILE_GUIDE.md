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
| 04 | `04-bootstrap.js` | The loading-screen progress bar, the `auth.onAuthStateChanged` handshake, `initialLoad()` (one authoritative server read of every collection + one-time DB seed), `attachRealtimeListeners()` (the Firestore `onSnapshot` listeners that keep the app live), and `refreshGlobalUI()` - the function every realtime update funnels through to re-render whichever view is currently open. |
| 05 | `05-catalog-and-announcements.js` | The tag and rank/role catalogs (`DEFAULT_TAGS`/`DEFAULT_ROLES`, `tagToId`/`roleToId`), shift-position slot math (`eventOpenSlots`, `positionFilled`), event auto-archiving (`runAutoArchiveSweep`, `archiveEvent`, `restoreEvent`, `renderArchive`), and the whole System > Announcement Banner feature (preview, save, live toggle, expiry sweep). |
| 06 | `06-auth-and-shell.js` | `currUser()`, sign-in/registration (`handleAuth`, `toggleAuth`, `friendlyAuthError`, `forgotPassword`, `logout`), session validation (`validateSession`), the Terms & Conditions scroll-gate, the user-name and "Add to Calendar" header dropdowns, unread-chat-badge tracking, and `switchView()` - the function that shows/hides every top-level view section. |
| 07 | `07-events-and-details.js` | The Events feed tiles (`renderEvents`), the full event detail page (`renderEventDetail`) including the roster, Available Positions list, and per-shift chat, plus claiming/dropping a shift or a specific position (`toggleSignUp`, `claimPosition`). |
| 08 | `08-calendar.js` | The month-grid Calendar tab (`renderCal`, `changeMonth`). |
| 09 | `09-admin-events.js` | Command Center > Events: the PIN gate (`promptAdminPin`), the whole staged-draft shift editor (create/edit/save a posting, positions, timeline, roster, promoter links - everything prefixed `draft*`), and the admin tab-switcher (`switchAdmin`). This is the largest file - it's one cohesive feature (the event editor), not several. |
| 10 | `10-admin-ops.js` | The rest of Command Center: Chat Management (channels/messages), the Tag and Rank/Role catalog managers, Logs, and the Users table + add/edit/delete-user modal (including the admin-creates-an-account flow). |
| 11 | `11-settings-and-calendar.js` | The per-user Settings tab (profile, password, notification prefs, delete-my-account), My Shifts, the Promoter/Contact directory and its admin editor, and "Add to Calendar" (.ics / Google Calendar link generation). |
| 12 | `12-banlist-chat-misc.js` | The Ban List (open to all signed-in users), Team Chat (`renderChat`, `sendChat`, channel switching, file attachments), the About modal pages, the first-open Welcome popup, the generic `closeModal()` helper, and the admin PIN-change form. |

## Load order rules

Per [ARCHITECTURE.md](ARCHITECTURE.md), load order only matters for code that
runs *immediately* (not inside a function) when its file loads. Here is
every such statement in the app, and why each one is safe regardless of
which file loads next:

| File | Statement | Why it's safe |
|---|---|---|
| `00-loading-mascot.js` | `(function initLoadingMascot() {...})();` | Fully self-contained IIFE; touches nothing outside this file. |
| `01-firebase-init.js` | `firebase.initializeApp(firebaseConfig);` | Uses only the `firebaseConfig` object defined earlier in this same file. |
| `04-bootstrap.js` | `setTimeout(() => { ... dropLoadingScreen(); }, HARD_LOAD_TIMEOUT_MS);` | Registers a 20s timer; `dropLoadingScreen` is defined earlier in this same file. The callback body only *runs* long after every file has loaded. |
| `04-bootstrap.js` | `auth.onAuthStateChanged(async (user) => {...});` | Registers an async callback. It references functions from several other files (`updateDockForUser`, `requestNotificationPermission`, etc.), but Firebase can't fire this callback synchronously during page load - by the time it fires, all 13 files have finished executing. |
| `06-auth-and-shell.js` | Two `document.addEventListener('click', ...)` calls (user menu / calendar-menu dismiss-on-outside-click) | Registers listeners; the callback bodies only call functions already defined earlier in this same file, and only run on a later real click. |
| `06-auth-and-shell.js` | `populateTermsContainers();` | Calls a function defined earlier in this same file, which only touches DOM elements that already exist (the whole `<body>` is parsed before any `<script>` tag runs). |

If you ever add a new top-level (not-inside-a-function) statement to any
`js/*.js` file, ask whether it calls something that might not be defined yet
- if so, either move it inside a function/callback (so it runs later, after
everything's loaded) or make sure the file it depends on loads first in
`index.html`.
