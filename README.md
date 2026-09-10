# Volley Bandit

Lineups, rotations, and live stat entry for a volleyball coach running the
bench solo. Built to work with zero signal — everything lives on the device,
not a server.

## What's here

This is a real, runnable project — a Vite + React app, installable as a PWA
(add it to your phone's home screen like a native app). Two things make it
more than a local demo:

1. **Cloud sync via Firebase.** Every piece of data (roster, lineups,
   matches, stat log, team info) is stored in Firestore under your team's
   own code — see "Setting up Firebase" below. Any device linked to the
   same team code sees the same data, live.
2. **Offline-first, not just offline-tolerant.** Firestore's own offline
   cache (enabled in `src/firebase.js`) means reads come from the local
   cache instantly and writes queue up and sync automatically once a
   connection comes back — this is what makes it keep working with zero
   signal in a gym, not just "usually" work. `vite-plugin-pwa` handles the
   other half: caching the app's own code so it loads with no network at
   all after the first visit.

## Setting up Firebase (required — this is what makes sync work)

The app won't run without this. You need your own free Firebase project;
Firebase doesn't come pre-configured because that would mean sharing
database credentials in this README.

1. Go to **[console.firebase.google.com](https://console.firebase.google.com)**
   and sign in with a Google account.
2. Click **Add project**, name it something like `volley-bandit`, and
   click through the setup (you can decline Google Analytics, it's not
   needed here).
3. Once the project's created, click the **`</>`** (web) icon on the
   project overview page to register a web app. Give it any nickname —
   you don't need Firebase Hosting, just registering the app.
4. It'll show you a `firebaseConfig` object with values like `apiKey`,
   `authDomain`, `projectId`, etc. Copy those into `src/firebase.js`,
   replacing the placeholder values there.
5. In the left sidebar, go to **Build → Firestore Database** → **Create
   database**. Choose any region close to you, and start in **test mode**
   for now (this matters — see the security note below).
6. That's it — the app reads/writes to this project automatically once
   the config is filled in.

### A real security note

Firestore's "test mode" allows anyone with your project's config to read
and write to it, for 30 days, after which it locks down by default. For
this app to keep working past that window, go to **Firestore Database →
Rules** and set:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

Be clear-eyed about what this means: it makes your Firestore database
open to anyone who has your team code (since that's the only thing
gating which document someone reads or writes) *and* technically anyone
who found your Firebase project's public config, if they went looking
for it and knew to query Firestore directly rather than going through
the app. In practice that's an extremely unlikely threat for a personal
coaching tool — but it's not the same thing as real access control, and
it's worth knowing the difference rather than assuming "rules are set"
means "secure." The app's own passcode screen and team code are the real
practical gate here; the Firestore rule above is just what lets the app
function past the 30-day test-mode window.

## Running it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Hot-reloads as you edit.

Note: the offline service worker only activates in a **production build**
(`npm run build` + `npm run preview`), not in `npm run dev`. If you want to
actually test offline behavior — turn on airplane mode and confirm it still
loads — do that against the preview build, not the dev server.

```bash
npm run build
npm run preview
```

## Icons

`public/icon-192.png`, `public/icon-512.png`, and `public/favicon.svg` are
placeholder marks (a simple net-and-ball motif in the app's color scheme).
Swap them for a real team or app logo whenever you want — same filenames,
same sizes, and the manifest in `vite.config.js` will pick them up
automatically.

## Putting it on GitHub

This is exactly the kind of project that belongs in a repo:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

GitHub hosts the *source* — code, history, README. It doesn't run the app
by itself. To get an actual URL you can open on your phone, deploy the built
site somewhere. A few good, free options:

- **GitHub Pages** — deploys straight from the repo; simplest if you want
  everything in one place. Requires a small `base` path tweak in
  `vite.config.js` if the repo isn't served from the domain root.
- **Vercel** or **Netlify** — connect the GitHub repo, both auto-detect Vite
  and build/deploy on every push, no extra config needed.

Once deployed, open the URL on your phone and use "Add to Home Screen"
(iOS Safari) or the install prompt (Android Chrome) to install it like a
real app.

## How the Team Code works

The first time the app opens on a device with no team linked, it shows a
Create/Join screen:

- **Create New Team** generates a short random code (like `GRF-4X29`) and
  shows it once — write it down.
- **Join Existing Team** links this device to a code you already have.

Every device linked to the same code reads and writes the same Firestore
data, live. Two different coaches using this same deployed app each create
their own team and never see each other's data — the app-wide passcode (if
you've set one) is a separate outer gate that applies before any of this,
same as before.

Switch or unlink a device from its team anytime via the "Switch Team"
button on the Roster tab.

## What's intentionally still open

Carried over from the product spec. The should-haves (rotation/sub undo,
editable matches, safer deletion) and this round's four (timeouts, CSV
import/export, tap-through navigation, season-to-date stats) are all done
as of this version. Multi-device sync — the one item that used to be a
bigger, separate undertaking — is now built (see above). What's left is
genuinely nice-to-have, not correctness-critical:

- **Multiple teams per coach** (varsity/JV/club) — a device links to one
  team code at a time; managing several would mean either multiple team
  codes and a switcher, or restructuring how a "team" is scoped.
- **Archive/reactivate players** — deleting a player is currently permanent.
- **True simultaneous-edit safety** — two devices editing the exact same
  field within the same second will have the second write win silently.
  For one coach switching devices, or two coaches touching different data
  (rotation/score vs. stat entry), this essentially never comes up in
  practice — but it's not conflict-free the way a purpose-built
  multiplayer app would be.

None of these block using the app for a real match today.
