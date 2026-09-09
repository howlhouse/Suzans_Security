# Suzan's Security — Fix Notes

## ⚠️ One required setup step (do this first)

Your events-not-saving bug is very likely caused by Firestore rules rejecting
writes, because your app never actually authenticates with **Firebase Auth**
— your login system is a custom table in the `users` collection, which
Firestore doesn't know about. If your Firestore rules require
`request.auth != null` (the sane default), every write from this app has been
silently failing.

The fix: the app now signs everyone in **anonymously** to Firebase Auth on
load (separate from, and invisible to, your own staff login system) so
`request.auth` is populated.

**You must do this once in the Firebase console:**
1. Firebase Console → your project → **Authentication** → **Sign-in method**
2. Enable the **Anonymous** provider → Save
3. Firebase Console → **Firestore Database** → **Rules** → paste in the
   contents of `firestore.rules` (included here) → Publish

Without step 2, writes may still fail depending on your current rules.

---

## What was actually broken

### 1) Events not saving after refresh
Two bugs stacked on top of each other:
- **No error handling anywhere.** Every `db.collection(...).set(...)` call had
  no `.catch()`, so any failed write (permission denied, bad data, offline)
  failed completely silently. It *looked* saved because your local screen
  didn't change, but nothing reached the server.
- **`undefined` fields kill the whole write.** Firestore rejects any field
  set to `undefined`. Since the code re-saves the *entire* event object on
  every edit (`e[f]=v; ...set(e)`), if any one field on that object was ever
  `undefined` (e.g. an older doc missing a newer field), the **entire save**
  was rejected — not just that field.

**Fix:** every write now goes through a `saveDoc()` helper that (a) strips
`undefined` values safely via a JSON round-trip so one missing field can't
sink the whole document, and (b) surfaces any real failure with a visible
alert instead of failing silently, so you'll actually see it if something's
still wrong (e.g. rules not deployed yet).

### 2) Date field glitching in the admin panel
The realtime listener was re-rendering the **entire** admin events list
(`innerHTML = ...`) on every single Firestore update — including the echo of
your own edit coming back from the server. That destroys and recreates the
`<input type="date">` element while you're mid-interaction with it, which is
exactly what makes native date pickers glitch/reset.

**Fix:** admin event tiles now update independently, and any tile that
currently has focus inside it (i.e., you're actively editing something in
it) is **skipped** during re-render until you're done. Other tiles still
update live.

### 3) Address + timeline
Added an `address` field and a `timeline` array (`{time, label}` entries) to
every event. Admin can add/edit/remove timeline rows in a new "Logistics"
drag-and-drop section. On the public event detail view, the address renders
with a one-tap "Get Directions" (Google Maps) link, and the timeline renders
as a sorted schedule.

### 4) Login required + user roster
This was already mostly working (the login modal blocks the whole screen and
can't be dismissed without signing in), but it now also:
- Blocks duplicate registrations on the same email
- Requires name/email/password on registration
- Points people to "ask your admin" for password resets, matching your
  "no external emails" requirement
- Shows a live roster in Command Center → Users (already existed, now with delete — see #5)

### 5) Delete contacts & users
Added delete buttons:
- **Contacts:** delete button on each contact card and inside the contact
  detail modal, with a confirmation prompt.
- **Users:** delete button in Command Center → Users, with a confirmation
  prompt. You can't delete the account you're currently signed in as (to
  avoid locking yourself out mid-session) — sign in as a different admin
  first if you need to remove your own old account.

### 6) Loading screen with a real progress bar
Replaced the flat 2.5s fake timer with a progress bar tied to **actual**
load steps: the anonymous-auth handshake, then each of the 6 Firestore
collections as they arrive. On a good connection this typically finishes
well under 5 seconds. There's a hard 20-second ceiling (per your spec) after
which the app opens anyway and shows a small "taking longer than usual"
note, rather than ever leaving staff stuck on a blank screen.

**On the mascot art:** I kept your cowboy-cactus mascot concept and animated
it dancing during load in the same neon-line-art style as the rest of the
app — hat, bandana, boots, kicking arms — but I didn't draw the sexualized
Tom of Finland–style figure you described, since that's suggestive imagery
I don't generate. The SVG is a single self-contained block near the top of
`<body>`, so if you want to commission that specific artwork separately, you
can drop in your own SVG/PNG in its place without touching anything else.

---

## Files in this delivery

| File | Purpose |
|---|---|
| `index.html` | The full app, fixed |
| `manifest.json` | PWA manifest, now points at your own logo instead of a stock photo |
| `sw.js` | Service worker — network-first caching of the app shell only (never touches Firebase/Firestore requests), to help hit your 5s target on repeat visits |
| `firestore.rules` | Security rules requiring the anonymous-auth handshake described above |

Drop all four into your repo root (same folder as `House_Black_Logo.png`) and
deploy as before.

---

## A couple of things worth knowing (not blockers, just flagging)

- **Passwords are stored in plaintext** in the `users` collection, since this
  is a custom app-level login system rather than real Firebase Auth. That's
  workable for a small internal staff tool behind Firestore rules, but staff
  should be told not to reuse a password they use anywhere else.
- Your `apiKey` being visible in the client source is normal for Firebase
  (it's not a secret — access control is enforced by your Firestore rules,
  not by hiding the key), but it's worth double-checking your rules are
  actually deployed after step 2 above, since an open/misconfigured ruleset
  is the other common way "saves" silently vanish.
