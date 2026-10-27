# Suzan's Security — Staff Portal

**A staff scheduling, communications, and operations portal for Suzan's Security, a Phoenix, AZ–based security staffing team serving LGBTQ+ nightlife, club, and event venues.**

Created and managed in partnership with **Howlhouse, LLC**.

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Core Features](#core-features)
4. [Data Model](#data-model)
5. [Project Structure](#project-structure)
6. [Setup & Deployment](#setup--deployment)
7. [Configuration](#configuration)
8. [User Guide](#user-guide)
9. [Admin Guide](#admin-guide)
10. [Security Notes](#security-notes)
11. [Progressive Web App (PWA) Behavior](#progressive-web-app-pwa-behavior)
12. [Known Limitations](#known-limitations)
13. [Developer Documentation](#developer-documentation)
14. [Version History](#version-history)

---

## Overview

Suzan's Security is a mobile-first web application used internally by guards, officers, and administrators to:

- Browse and claim upcoming shift postings ("events") at Phoenix-area venues and circuit parties
- View shift details, venue addresses, operational timelines, and client/promoter contacts
- Coordinate in real time via team chat channels and per-event shift chat
- Track promoter/client relationships and debrief notes
- Manage the staff roster, shift assignments, and post assignments (door, bag check, float, etc.)
- Give administrators a single **Command Center** to manage events, chat, users, contacts, and activity logs

The app is designed to be installed as a Progressive Web App (PWA) on officers' phones for quick access before and during shifts.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Single-page vanilla HTML/CSS/JavaScript, split across `styles.css` and `js/*.js` by feature for maintainability (no build step, no framework — see [Project Structure](#project-structure)) |
| Backend / Database | Google Firebase — **Cloud Firestore** (real-time NoSQL database) |
| Auth | Firebase Authentication (Email/Password provider) — staff register and sign in with real Firebase Auth accounts |
| Hosting | Static hosting (e.g., Firebase Hosting, GitHub Pages, or any static file host) |
| Offline / Install | Web App Manifest + Service Worker (installable PWA) |
| Fonts | Google Fonts (Outfit, Plus Jakarta Sans) |

There is no server-side application code — all logic runs client-side in the browser, and Firestore is accessed directly from the client using the Firebase Web SDK (compat build).

---

## Core Features

### Shift Postings ("Events")
- Card-based feed of upcoming shifts with venue photo, date, tags, and description
- One-tap "Claim Shift" / "Cancel Shift"
- Per-shift roster showing assigned officers and their post assignment (Door, ID Check, Float, Dancefloor, etc.)
- Venue address with a one-tap "Get Directions" link
- Operational timeline (time-stamped run-of-show items)
- Linked client/promoter contact card(s) — an event can have more than one promoter attached
- Live shift-specific chat thread
- Content tags (SFW, NSFW, 18+, Kink, Themed, etc.) for at-a-glance context

### Calendar
- Month view of all scheduled shifts, tap-through to shift detail

### Team Comms
- Multi-channel team chat (in addition to per-shift chat threads)
- File/image attachment support
- Push-style browser notifications for new shifts and new messages (when permission is granted)

### Promoter Directory
- Read-only directory, open to every signed-in user via the account dropdown next to the user's name (not just admins)
- Lists every promoter/client contact with phone, email, and optional Instagram/website/venue links
- Shows every event each contact is linked to as a promoter, past and upcoming, tap-through to shift detail

### Command Center (Admin)
Gated behind a PIN, with the following management tabs:

- **Events** — create, edit, reorder (drag-and-drop layout), and delete shift postings; manage tags, roster, logistics, and timeline
- **Chat Mgmt** — create/delete channels, clear channel history, moderate individual messages, review attachments
- **Logs** — chronological activity log (logins, shift claims/drops, registrations, post assignments)
- **Users** — view all staff accounts, promote/demote admin ("Commander") status, reset passwords, delete accounts
- **Contacts** — manage promoter/client records (including optional Instagram, website, and venue links), tags, and debrief notes; delete contacts
- **ID Scan** — per-event ID checking rules, the registry of scanned IDs, and data retention (see [ID Scanning](#id-scanning))
- **PIN** — change the admin PIN

### Accounts
- Self-service registration and login via real Firebase Authentication (email/password)
- The first person to ever register is automatically made an admin, which is how Command Center access gets bootstrapped on a fresh database
- Duplicate-email protection at registration (enforced by Firebase Authentication itself)
- Self-service password resets via a Firebase-sent reset email, which an admin can also trigger on a staff member's behalf
- Session validated against the live user roster — if an account is deleted or the app data is reset, that session is automatically signed out rather than remaining active indefinitely

---

## Data Model

All data lives in Cloud Firestore. Collections:

| Collection | Purpose | Key fields |
|---|---|---|
| `events` | Shift postings | `id`, `title`, `date`, `desc`, `address`, `timeline[]`, `tags[]`, `image`, `ticketLink`, `openSlots`, `guards[]`, `guardPosts{}`, `promoterIds[]` (legacy single-promoter events may still carry `promoterId`), `layout[]` |
| `users` | Staff accounts | `id`, `name`, `email`, `phone`, `password`, `isAdmin` |
| `channels` | Team chat channel names | document ID = channel name |
| `chats` | Chat messages (both team channels and per-event threads, distinguished by `channel` field) | `id`, `channel`, `user`, `text`, `file` |
| `promoters` | Client/promoter contacts | `id`, `name`, `phone`, `email`, `instagram`, `website`, `venueLink`, `tags[]`, `notes[]` |
| `logs` | Activity/audit log | `id`, `time`, `user`, `action` |
| `_meta` | Internal app metadata (currently just the one-time database seed flag) | `seedStatus.seeded` |

Data syncs in real time to every connected client via Firestore's realtime listeners — there is no manual refresh needed to see other users' updates (event claims, new chat messages, admin edits, etc.).

---

## Project Structure

```
.
├── index.html           # Markup only — links styles.css, loads js/*.js in order
├── styles.css           # All app styling
├── js/                  # App logic, split by feature (see docs/FILE_GUIDE.md)
│   ├── 00-loading-mascot.js
│   ├── 01-firebase-init.js
│   ├── 02-notifications.js
│   ├── 03-state-and-persistence.js
│   ├── 04-bootstrap.js
│   ├── 05-catalog-and-announcements.js
│   ├── 06-auth-and-shell.js
│   ├── 07-events-and-details.js
│   ├── 08-calendar.js
│   ├── 09-admin-events.js
│   ├── 10-admin-ops.js
│   ├── 11-settings-and-calendar.js
│   ├── 12-banlist-chat-misc.js
│   └── 13-init.js
├── manifest.json        # PWA manifest (app name, icons, theme colors)
├── sw.js                 # Service worker (app-shell caching for fast repeat loads)
├── firestore.rules      # Firestore security rules
├── docs/                # Developer documentation — see docs/ARCHITECTURE.md and docs/FILE_GUIDE.md
└── House_Black_Logo.png # HowlHouse brand logo, used in-app and as the PWA icon
```

There is intentionally no build step or bundler — every file here is plain,
static HTML/CSS/JS, deployable as-is to any static host. The app used to be
one file with everything inlined; it's now split into the files above purely
for maintainability (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why
and how that split works). Nothing about how the app runs, looks, or behaves
changed as part of that split.

---

## Setup & Deployment

### 1. Firebase project setup
1. Create (or use the existing) Firebase project.
2. Enable **Cloud Firestore** in Native mode.
3. Enable **Firebase Authentication → Sign-in method → Email/Password**. This is required — see [Security Notes](#security-notes) for why.
4. Publish the contents of `firestore.rules` under **Firestore Database → Rules**.
5. Copy your project's Firebase config object into the `firebaseConfig` constant in `js/01-firebase-init.js` (already populated for the current project).

### 2. Deploy the static files
Upload the whole repository directory — `index.html`, `styles.css`, `js/`, `manifest.json`, `sw.js`, `firestore.rules`, and the image/logo assets — to any static host, preserving the folder structure (`js/*.js` must stay under a `js/` subfolder relative to `index.html`). For example:
- Firebase Hosting (`firebase deploy`)
- GitHub Pages
- Netlify / Vercel / any static file server

No server-side runtime, database credentials file, or build process is required.

### 3. First run
On first load with an empty database, the app automatically seeds:
- A `general` chat channel
- One sample promoter contact
- One sample shift posting

There is no pre-seeded admin account — **register the first account through the app itself**. The very first person to ever register is automatically made an admin, which is how Command Center access gets bootstrapped on a fresh database.

This seeding is permanently guarded by a flag document (`_meta/seedStatus`) and will not run again once it has completed once, even across reloads or database resets of individual collections.

---

## Configuration

| Item | Location | Notes |
|---|---|---|
| Firebase project credentials | `firebaseConfig` in `js/01-firebase-init.js` | Not a secret — access is controlled by Firestore rules, not by hiding this value |
| Admin PIN | Set via Command Center → PIN; stored in the browser's `localStorage` (`ss_pin`) | Defaults to `0000` until changed |
| Preset event tags | `DEFAULT_TAGS` constant in `js/05-catalog-and-announcements.js` | Edit this array to add/remove tag options |
| Guard post options | `renderEventDetail()` in `js/07-events-and-details.js` | Edit the inline array of post names |
| App icon / theme colors | `manifest.json` | Points to `House_Black_Logo.png` |

---

## User Guide

1. **Register** with a name, email, phone, and password (no email verification is sent — this is a closed internal system).
2. Browse the **Events** feed and tap **Claim Shift** on any posting with open slots.
3. Open a shift's detail page to see the venue address, operational timeline, client contact, and full roster, and to set your specific post assignment.
4. Use **Comms** for general team chat, or the chat thread inside a specific shift for shift-specific coordination.
5. Check the **Calendar** tab for a month-at-a-glance view of all postings.
6. Forgot your password? Tap the reset link on the sign-in screen to get a password reset email sent to your address — no need to wait on an administrator.
7. Tap your name in the header and choose **Promoter Directory** to browse every client/promoter contact — phone, email, Instagram/website/venue links, and which events they're tied to.

---

## Admin Guide

Tap the 🔒 **Admin** icon in the bottom dock and enter the PIN (default `0000` — change this immediately in **Command Center → PIN**).

- **Events tab:** Click **+ New Shift Posting** to create a shift. Edit any field, then click **Save Changes** on that event to commit — nothing is written until you explicitly save. Drag section blocks (image, info, tags, logistics, roster) to reorder how they display. In the info section, pick as many promoter/client contacts as apply to the event (or none) — they're just toggled on/off, no separate step needed. Use **Delete Tile** to permanently remove a posting.
- **Chat Mgmt:** Add/remove channels, clear a channel's history, or delete individual messages.
- **Logs:** Read-only audit trail of login/claim/registration activity.
- **Users:** Toggle a user between Guard and Commander (admin) status, send a user a password reset email, or delete an account.
- **ID Scan:** See [ID Scanning](#id-scanning) below.
- **Contacts:** Add promoters/clients, tag them, and log debrief notes after events. Optionally add Instagram, website, and venue links — these show up for everyone in the Promoter Directory (not on the event detail page itself). Delete contacts that are no longer active.

### ID Scanning

Staff tap the **ID Scan** icon in the bottom dock (or **ID Scanner** in their name menu), pick which event they're scanning for, and only then does the camera start. A **Light** button switches the phone's flashlight on where the browser allows it (Android Chrome does; iPhone Safari generally doesn't). Admins set the rules and read the registry in **Command Center → ID Scan**.

- **Scanning:** the phone camera (reads the PDF417 barcode on the back of a US/Canadian driver license or ID card) or an external USB/Bluetooth scanner that acts like a keyboard. Chrome on Android uses the browser's built-in reader; iPhones and anything else download a WebAssembly reader (zxing-wasm from jsDelivr), so camera scanning needs a connection. An external scanner or pasted barcode text works offline.
- **Continuous mode (external scanner):** with a USB/Bluetooth scanner the screen scans continuously. Passes and fails log themselves and the result stays on screen until the next scan; nobody has to tap unless an ID needs a decision (**Check this ID** → Admit/Deny, or a required photo). After each scan there is a 2-second pause (`IDS_PAUSE_MS`) during which scanner input is ignored, so one ID can't scan twice; scanning the same ID again after the pause is flagged as already scanned. A status line shows Ready / Pausing / Waiting. Optional photos are skipped in this mode, and the screen is kept awake while scanning.
- **Colour and sound (camera and external scanner):** the whole scanner gets a thick frame and glow in the result's colour (green pass, orange check, red do-not-admit) and the result card has a solid colour banner. Every scan also plays a sound: a bell "ding" for a pass, a low "buzz" for anything else (a check or a turn-away). Staff can mute their own screen with the 🔊 button.
- **What "verified" means:** there is no public database of driver licenses (they are protected by the federal Driver's Privacy Protection Act), so every check runs on the device against the barcode data: valid structure, issuing state, expiry, minimum age, a name match against the Ban List, and a repeat-scan check per event. Results are **Pass**, **Check this ID** (orange: a person decides Admit/Deny) or **Do not admit**. Real-time verification with the issuing state needs a paid vendor and a server-side API key; `idsVerifyExternal()` in `js/14-id-scan.js` is the one place to add it.
- **All barcode data:** each scan card has a **View all barcode data** section listing every field the card carries (ID number, address, physical description, issue/revision dates, REAL ID status and so on) plus the raw barcode text. It is shown on screen only and is never saved.
- **Per-event rules:** on/off, minimum age, turn away expired IDs, home state (IDs from any other state still pass but get a ⚠️ next to the state on the scan card and in the registry; defaults to AZ, blank turns it off), accepted states (a hard list: anything else is turned away), Ban List action, flag re-scans, flag unusual barcodes, and photo (off / optional / required).
- **Registry:** first and last name (the middle name is never stored or shown), birth date, state, ID expiry, scan time, who scanned, result, notes from the check, and an optional photo taken at the door. Unless Full Card Data is turned on, the ID number and address are read but **never stored**. Admins can search by last name or birth date, filter by event and result, export CSV, and delete records. Scans made on the DEV site are tagged as tests and hidden by default.
- **Flag for Ban List review:** any staff member can tap **🚩 Flag for Ban List review** on a scan, add a note, and send it. Nothing goes on the Ban List until an admin approves it in **Command Center → ID Scan → Flagged for Ban List** (add to the Ban List, which copies only the name and a note, or dismiss). Admins can also add someone straight from a registry record.
- **Full card data (temporary):** an admin can set **Full Card Data** to a number of hours (1-72; 0 = off, the default). While it's on, everything on each scanned ID (ID number, address, the lot) is stored for admins only for that long, shown on the registry record with a countdown, then it's unreadable and deleted. Also set a Firestore TTL policy on the `expireAt` field of the `idscan_full` collection as a backstop. Counsel should approve this before it's turned on.
- **Retention:** admins choose how many days records and photos are kept (0 = until deleted); older ones are deleted when an admin opens the ID Scan tab.
- **Access control:** the `idscan_*` collections have their own rules in `firestore.rules` (staff can add records and flags as themselves; only admins can read the registry and full card data, change or delete them). **Publish the updated `firestore.rules` in the Firebase Console before using this** - the rules are not part of the automatic release.
- **Legal:** some states restrict storing data from scanned licenses, and a registry of who attended LGBTQ+ events is sensitive. Have counsel review before relying on it, and consider a short retention period.

---

## Security Notes

This is an internal tool built for a small, trusted staff team, with tradeoffs made accordingly:

- **Real Firebase Authentication (Email/Password provider)** gates staff sign-in and registration. Passwords are never handled or stored by the app itself — Firebase owns credential storage, and password resets go out as real emails via Firebase, not through the app or Firestore.
- **Firestore rules** (see `firestore.rules`) require a real, signed-in Firebase Auth user (`request.auth != null`) before any read or write is allowed, which prevents drive-by access to the database via the public Firebase config.
- **Removing a user's access** deletes their profile document from Firestore immediately, but their underlying Firebase Auth credential has to be removed separately from the Firebase Console (Authentication → Users) — the app's delete action can't do that part for you (the delete confirmation prompt in Command Center → Users includes this reminder).
- **Session validation:** the app periodically checks that the locally stored session still corresponds to an account that exists in the live `users` collection, and force-logs-out automatically if not (e.g., if an admin deletes that account, or if app data has been reset).

---

## Progressive Web App (PWA) Behavior

- `manifest.json` allows the app to be "installed" to a phone's home screen with a standalone (browserless) window.
- `sw.js` implements network-first caching of the app shell (`index.html`, `styles.css`, every file in `js/`, `manifest.json`, the logo) so repeat loads are fast, while never caching or intercepting Firebase/Firestore network calls — live data is always fetched fresh.
- The loading screen shows real progress across the authentication handshake and each of the six Firestore collections, and will always proceed into the app within 20 seconds even in a degraded network condition.

---

## Known Limitations

- No automated tests or CI pipeline — this is a set of static files with no build step.
- No real-time presence indicators (e.g., "who's currently online").
- File attachments in chat use temporary local object URLs (`URL.createObjectURL`) rather than persistent cloud storage — attachments will not survive a page reload for the sender, and are not uploaded anywhere durable. Wiring this to Firebase Storage is a natural next step if persistent attachments are needed.
- No pagination — all events, chats, users, and logs are loaded in full on every session. This is fine at current staff/event volume but would need revisiting at significant scale.

---

## Developer Documentation

For anyone (human or AI) making changes to this codebase, see the `docs/` folder:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — why the app is split into `styles.css` + `js/*.js`, how classic multi-file scripts share global scope, and the guarantee that this split changed no behavior.
- **[docs/FILE_GUIDE.md](docs/FILE_GUIDE.md)** — a one-line purpose and function list for every file in `js/`, so you can jump straight to the file that covers the feature you're touching instead of reading the whole app.

---

## Version History

- **ID Scanning** — scan driver license / ID barcodes with the camera or an external scanner, check them against per-event rules, and keep an admin-only registry (Command Center → ID Scan). New files: `js/14-id-scan.js`; new rules in `firestore.rules`.
- **Split the single-file app into `styles.css` + `js/*.js` by feature** — pure reorganization for maintainability, with no change to markup, styling, or logic (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how that was verified).
- **Login/session hardening** — local sessions are now validated against the live user roster and force-logged-out if the account no longer exists.
- **Admin event editor rebuilt around drafts** — edits to a shift posting are held locally and only written to the database when **Save Changes** is clicked, eliminating a class of bugs where in-progress edits (especially the date field) were being overwritten by incoming real-time updates.
- **Fixed a data-loading race condition** that could, on some reloads, cause the app to briefly show a blank feed before populating, and in rarer cases caused the database to be mistakenly re-seeded over real edits. Seeding is now a one-time, permanently-flagged operation.
- **Added Firebase Anonymous Authentication** to satisfy Firestore security rules requiring `request.auth != null`, resolving silent write failures.
- **Hardened all database writes** against a Firestore quirk where a single `undefined` field could silently fail an entire document save; failures are now also surfaced to the user instead of failing invisibly.
- **Added venue address and operational timeline fields** to shift postings, surfaced on the shift detail page with a "Get Directions" link.
- **Added delete functionality** for staff accounts and promoter/client contacts.
- **Rebuilt the loading screen** with a real progress bar tied to actual data-loading steps (rather than a fixed timer), with a 20-second hard ceiling.
