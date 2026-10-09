# PROD and DEV

The app is published in two versions from this one repository:

| | Branch | Address | Who uses it |
|---|---|---|---|
| **PROD** | `main` | the normal app address | the whole team |
| **DEV** | `dev` | the same address + `/dev/` | developers only (users with the **DEV** checkbox) |

Both use the **same Firebase project and the same live data**. Be careful with
anything in DEV that writes or deletes data. Sign-in is shared between the two
(same site), so switching doesn't ask you to sign in again.

## The toggle

Users with the DEV checkbox (Command Center -> Users -> Edit) see a **PROD | DEV**
switch at the top of the app. It jumps between the two addresses. Anyone else who
opens `/dev/` is sent back to PROD. The DEV version also shows an orange banner and
`[DEV]` in the tab title so it's never mistaken for the real app.

## Everyday workflow

1. **Build on `dev`.** Commit and push changes straight to the `dev` branch. Within about a
   minute they're live at `/dev/` - try them there with the PROD | DEV switch.
2. **Release with "/publish to prod".** When DEV looks good, say that phrase. The branch
   `dev` is merged into `main` through a pull request and the live app updates.
3. Don't push feature work directly to `main`. If an urgent fix ever does go straight to
   `main`, merge `main` back into `dev` afterwards so the two don't drift.

Manual Firebase steps (publishing `firestore.rules`, creating an index) are never part of the
automatic release - they're listed in the release report for you to do in the Firebase Console.

## How it's deployed

`.github/workflows/pages.yml` publishes `main` at `/` and `dev` at `/dev/` whenever
either branch changes. The repository's Pages setting must be **Build and deployment ->
Source: GitHub Actions** (it was changed from "Deploy from a branch" when this was set up).

## What DEV traffic does to the numbers

Activity logged from DEV is tagged `env: "dev"`. The adoption dashboard ignores it, and
"last seen" is not updated from DEV, so developer testing doesn't skew team statistics.

## Code notes

- `IS_DEV_SITE`, `PROD_URL`, `DEV_URL` (js/03-state-and-persistence.js) tell the code
  which version it's running as.
- The two versions use separate service-worker caches (`sw.js`) so they don't clobber
  each other.
- GitHub Pages ignores a second deployment of the *same commit*. If `dev` and `main` are at the
  same commit, only the first deployment of that commit takes effect - a new commit on either
  branch always deploys.
