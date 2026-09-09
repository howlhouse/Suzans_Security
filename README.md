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
13. [Version History](#version-history)

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
| Frontend | Single-page vanilla HTML/CSS/JavaScript (no build step, no framework) |
| Backend / Database | Google Firebase — **Cloud Firestore** (real-time NoSQL database) |
| Auth | Firebase Authentication (Anonymous provider) + a custom in-app username/password system layered on top |
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
- Linked client/promoter contact card
- Live shift-specific chat thread
- Content tags (SFW, NSFW, 18+, Kink, Themed, etc.) for at-a-glance context

### Calendar
- Month view of all scheduled shifts, tap-through to shift detail

### Team Comms
- Multi-channel team chat (in addition to per-shift chat threads)
- File/image attachment support
- Push-style browser notifications for new shifts and new messages (when permission is granted)

### Command Center (Admin)
Gated behind a PIN, with the following management tabs:

- **Events** — create, edit, reorder (drag-and-drop layout), and delete shift postings; manage tags, roster, logistics, and timeline
- **Chat Mgmt** — create/delete channels, clear channel history, moderate individual messages, review attachments
- **Logs** — chronological activity log (logins, shift claims/drops, registrations, post assignments)
- **Users** — view all staff accounts, promote/demote admin ("Commander") status, reset passwords, delete accounts
- **Contacts** — manage promoter/client records, tags, and debrief notes; delete contacts
- **PIN** — change the admin PIN

### Accounts
- Self-service registration and login (no external email verification — accounts are local to the app)
- Duplicate-email protection at registration
- Admin-driven password resets (no outbound email required)
- Session validated against the live user roster — if an account is deleted or the app data is reset, that session is automatically signed out rather than remaining active indefinitely

---

## Data Model

All data lives in Cloud Firestore. Collections:

| Collection | Purpose | Key fields |
|---|---|---|
| `events` | Shift postings | `id`, `title`, `date`, `desc`, `address`, `timeline[]`, `tags[]`, `image`, `ticketLink`, `openSlots`, `guards[]`, `guardPosts{}`, `promoterId`, `layout[]` |
| `users` | Staff accounts | `id`, `name`, `email`, `phone`, `password`, `isAdmin` |
| `channels` | Team chat channel names | document ID = channel name |
| `chats` | Chat messages (both team channels and per-event threads, distinguished by `channel` field) | `id`, `channel`, `user`, `text`, `file` |
| `promoters` | Client/promoter contacts | `id`, `name`, `phone`, `email`, `tags[]`, `notes[]` |
| `logs` | Activity/audit log | `id`, `time`, `user`, `action` |
| `_meta` | Internal app metadata (currently just the one-time database seed flag) | `seedStatus.seeded` |

Data syncs in real time to every connected client via Firestore's realtime listeners — there is no manual refresh needed to see other users' updates (event claims, new chat messages, admin edits, etc.).

---

## Project Structure

```
.
├── index.html          # The entire application (markup, styles, and logic)
├── manifest.json        # PWA manifest (app name, icons, theme colors)
├── sw.js                 # Service worker (app-shell caching for fast repeat loads)
├── firestore.rules      # Firestore security rules
└── House_Black_Logo.png # HowlHouse brand logo, used in-app and as the PWA icon
```

There is intentionally no build step or bundler — `index.html` is deployable as-is to any static host.

---

## Setup & Deployment

### 1. Firebase project setup
1. Create (or use the existing) Firebase project.
2. Enable **Cloud Firestore** in Native mode.
3. Enable **Firebase Authentication → Sign-in method → Anonymous**. This is required — see [Security Notes](#security-notes) for why.
4. Publish the contents of `firestore.rules` under **Firestore Database → Rules**.
5. Copy your project's Firebase config object into the `firebaseConfig` constant near the top of the `<script>` block in `index.html` (already populated for the current project).

### 2. Deploy the static files
Upload `index.html`, `manifest.json`, `sw.js`, and `House_Black_Logo.png` to the same directory on any static host — for example:
- Firebase Hosting (`firebase deploy`)
- GitHub Pages
- Netlify / Vercel / any static file server

No server-side runtime, database credentials file, or build process is required.

### 3. First run
On first load with an empty database, the app automatically seeds:
- One admin account (`admin@suzan.com` / `admin`) — **change this password immediately after first login**
- A `general` chat channel
- One sample promoter contact
- One sample shift posting

This seeding is permanently guarded by a flag document (`_meta/seedStatus`) and will not run again once it has completed once, even across reloads or database resets of individual collections.

---

## Configuration

| Item | Location | Notes |
|---|---|---|
| Firebase project credentials | `firebaseConfig` in `index.html` | Not a secret — access is controlled by Firestore rules, not by hiding this value |
| Admin PIN | Set via Command Center → PIN; stored in the browser's `localStorage` (`ss_pin`) | Defaults to `0000` until changed |
| Preset event tags | `PRESET_TAGS` constant in `index.html` | Edit this array to add/remove tag options |
| Guard post options | `renderEventDetail()` in `index.html` | Edit the inline array of post names |
| App icon / theme colors | `manifest.json` | Points to `House_Black_Logo.png` |

---

## User Guide

1. **Register** with a name, email, phone, and password (no email verification is sent — this is a closed internal system).
2. Browse the **Events** feed and tap **Claim Shift** on any posting with open slots.
3. Open a shift's detail page to see the venue address, operational timeline, client contact, and full roster, and to set your specific post assignment.
4. Use **Comms** for general team chat, or the chat thread inside a specific shift for shift-specific coordination.
5. Check the **Calendar** tab for a month-at-a-glance view of all postings.
6. Forgot your password? There is no self-service reset — ask an administrator to reset it for you in Command Center → Users.

---

## Admin Guide

Tap the 🔒 **Admin** icon in the bottom dock and enter the PIN (default `0000` — change this immediately in **Command Center → PIN**).

- **Events tab:** Click **+ New Shift Posting** to create a shift. Edit any field, then click **Save Changes** on that event to commit — nothing is written until you explicitly save. Drag section blocks (image, info, tags, logistics, roster) to reorder how they display. Use **Delete Tile** to permanently remove a posting.
- **Chat Mgmt:** Add/remove channels, clear a channel's history, or delete individual messages.
- **Logs:** Read-only audit trail of login/claim/registration activity.
- **Users:** Toggle a user between Guard and Commander (admin) status, reset a forgotten password, or delete an account.
- **Contacts:** Add promoters/clients, tag them, and log debrief notes after events. Delete contacts that are no longer active.

---

## Security Notes

This is an internal tool built for a small, trusted staff team, with tradeoffs made accordingly:

- **Custom authentication, not Firebase Auth (for staff accounts).** Staff login/registration is handled entirely by the app against the `users` collection in Firestore — it is *not* Firebase's built-in user authentication system. This is what makes fully self-service, no-email password resets possible, but it also means:
  - Passwords are stored in plaintext in Firestore. Staff should be advised not to reuse a password they use elsewhere.
  - There is no email verification or account recovery flow — recovery is entirely admin-driven, by design.
- **Firebase Authentication (Anonymous provider)** is used separately, purely to satisfy Firestore security rules requiring `request.auth != null`. Every browser session signs in anonymously to Firebase on load; this is invisible to staff and unrelated to their in-app username/password.
- **Firestore rules** (see `firestore.rules`) require that anonymous auth handshake to succeed before any read or write is allowed, which prevents drive-by access to the database via the public Firebase config.
- **Session validation:** the app periodically checks that the locally stored session still corresponds to an account that exists in the live `users` collection, and force-logs-out automatically if not (e.g., if an admin deletes that account, or if app data has been reset).

If this app is ever opened up beyond a small trusted internal team, moving staff authentication onto real Firebase Authentication (email/password or similar) and hashing credentials would be the natural next step.

---

## Progressive Web App (PWA) Behavior

- `manifest.json` allows the app to be "installed" to a phone's home screen with a standalone (browserless) window.
- `sw.js` implements network-first caching of the app shell (`index.html`, `manifest.json`, the logo) so repeat loads are fast, while never caching or intercepting Firebase/Firestore network calls — live data is always fetched fresh.
- The loading screen shows real progress across the authentication handshake and each of the six Firestore collections, and will always proceed into the app within 20 seconds even in a degraded network condition.

---

## Known Limitations

- No automated tests or CI pipeline — this is a single static file with no build step.
- No real-time presence indicators (e.g., "who's currently online").
- File attachments in chat use temporary local object URLs (`URL.createObjectURL`) rather than persistent cloud storage — attachments will not survive a page reload for the sender, and are not uploaded anywhere durable. Wiring this to Firebase Storage is a natural next step if persistent attachments are needed.
- No pagination — all events, chats, users, and logs are loaded in full on every session. This is fine at current staff/event volume but would need revisiting at significant scale.

---

## Version History

- **Login/session hardening** — local sessions are now validated against the live user roster and force-logged-out if the account no longer exists.
- **Admin event editor rebuilt around drafts** — edits to a shift posting are held locally and only written to the database when **Save Changes** is clicked, eliminating a class of bugs where in-progress edits (especially the date field) were being overwritten by incoming real-time updates.
- **Fixed a data-loading race condition** that could, on some reloads, cause the app to briefly show a blank feed before populating, and in rarer cases caused the database to be mistakenly re-seeded over real edits. Seeding is now a one-time, permanently-flagged operation.
- **Added Firebase Anonymous Authentication** to satisfy Firestore security rules requiring `request.auth != null`, resolving silent write failures.
- **Hardened all database writes** against a Firestore quirk where a single `undefined` field could silently fail an entire document save; failures are now also surfaced to the user instead of failing invisibly.
- **Added venue address and operational timeline fields** to shift postings, surfaced on the shift detail page with a "Get Directions" link.
- **Added delete functionality** for staff accounts and promoter/client contacts.
- **Rebuilt the loading screen** with a real progress bar tied to actual data-loading steps (rather than a fixed timer), with a 20-second hard ceiling.
