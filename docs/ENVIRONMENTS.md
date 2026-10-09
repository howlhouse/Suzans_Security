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

1. Create a branch from `dev` for the change, open a pull request **into `dev`**.
2. Merge it. Within about a minute it's live at `/dev/` - try it there.
3. When DEV looks good, **release to PROD**: open a pull request from `dev` into `main`
   (`gh pr create --base main --head dev`) and merge it.
4. Small urgent fixes can still go straight to `main`; afterwards merge `main` into
   `dev` so the two don't drift (`git checkout dev && git merge main`).

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
