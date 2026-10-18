# Sign-in — a sketch, not a plan of record

Status: **sketch**, 2026-10-18. Nothing here is built. It exists so the next
session (or the coach) can argue with a concrete proposal instead of
re-deriving the problem. Decisions still open are marked **OPEN**.

---

## 1. Why this exists

The Firestore rule today is:

```
match /{document=**} { allow read, write: if true; }
```

Anyone who can reach the project can read or write anything in it. Everything
protecting the data right now is the difficulty of guessing a team code, plus
code in the client that a determined person can simply not run.

That was a deliberate staging decision, not an oversight — player access and
assistant devices were built against current rules first, on the understanding
that sign-in follows as its own change. This is that change.

Two things have made it more pressing than it was:

- **There are now parties who are not the coach.** Players hold codes.
  Assistants hold devices. Both are new in the last week.
- **The commercial plan is multi-organisation.** One permissive rule across
  one project is survivable while the only data is one coach's team. It is not
  something to sell.

## 2. The constraint that outranks the others

**The app must never be the reason a coach can't record a match.**

That is not a nice-to-have. This thing runs courtside, on gym wifi, on a phone,
in an installed PWA, often with no usable signal, and the coach has twenty
seconds between rallies. Today there is *no way* for the app to lock them out —
the worst case is that sync is delayed. Sign-in introduces that possibility for
the first time, and a design that trades a small, hypothetical privacy risk for
a real chance of a dead screen during a match is a bad trade.

Everything below is shaped by that. Where the secure option and the
never-locked-out option disagree, this sketch picks the second and says so.

## 3. Who the actors actually are

| Actor | Needs | Has today |
|---|---|---|
| Coach | Everything, on 1–2 devices | The team code |
| Assistant device | Write stats/points; read what the coach allows | An assistant code |
| Player | Read one `playerAccess/{code}` document | A player code |
| Org admin (future) | Manage several teams, billing | Does not exist |

Note what this table says: **only the coach needs an account.** A player should
never make one — she is a minor and the whole point of her code is that it
carries no identity. A helper shouldn't have to either; they're borrowing a
tablet for an evening.

## 4. Proposed shape

### 4.1 Everyone is signed in, silently, from the first launch

`signInAnonymously()` at startup, in all three apps. No UI, no screen, no
friction. It gives every device a stable `uid` to write rules against, and
Firebase persists the token and refreshes it on its own, so **a device that has
signed in once keeps working offline indefinitely**. That property is what
makes this safe to do at all.

The failure mode to design for: a brand-new device with no signal cannot
complete a first sign-in. It will already be unable to load team data, so the
app should say "can't reach the server" and not pretend the problem is
sign-in — but it must not hard-block a device that has a valid cached token.

### 4.2 A coach UPGRADES that anonymous account rather than replacing it

Firebase `linkWithCredential` attaches an email (or Google) credential to the
*existing* anonymous uid. The uid doesn't change, so a coach who has been using
the app for months keeps ownership of the team they already own. No migration
of ownership, no re-claim, no window where the team belongs to nobody.

This is the single most important mechanic in the sketch. Any design that makes
the coach create a *new* account and then transfer the team is strictly worse.

**Email vs Google — OPEN.** Email-link ("magic link") avoids a password but
needs a reachable inbox at sign-in time, which is a bad courtside dependency.
Email+password works offline-after-first-use and is recoverable. Google is one
tap on most phones but adds a provider dependency and is awkward for a
school-issued device. Current lean: **email + password**, with Google as a
later addition.

### 4.3 Ownership and membership live on the team

- `teams/{team}/data/main.ownerUids: [uid, …]` — a list, not one id, same
  reasoning as `captainIds`: a head coach and an assistant coach both having
  real access is normal.
- `teams/{team}/members/{uid}` — `{ role: "assistant" | "coach", at }`. One
  document per device-or-person, which is what rules can read cheaply.

### 4.4 How an assistant device gets a membership WITHOUT the coach touching it

This is the part that looks impossible and isn't. The helper's device is signed
in anonymously, so it has a uid, but the coach has never seen that uid and
can't pre-authorise it.

The rule can check the code itself:

```
match /teams/{team}/members/{uid} {
  allow create: if request.auth.uid == uid
    && request.resource.data.role == "assistant"
    && request.resource.data.code ==
       get(/databases/$(database)/documents/teams/$(team)/data/main).data.assistantCode;
  allow read: if request.auth.uid == uid;
}
```

The device writes its own membership, proving it holds the current assistant
code; the rule verifies that against the team's live code. Afterwards, every
other rule reads the membership document rather than the code. This preserves
exactly the model already built and tested — *the code is the mode* — and
keeps "replace the code" meaningful, because a replaced code stops new devices
enrolling and the coach can delete existing member documents to evict.

The same trick does NOT work for making someone a coach: a rule that accepted
the team code as proof of ownership would leave the team code as the master key
to everything, which is the thing this project is trying to stop. **Coach
access must come from the account, not from a code.**

### 4.5 Player access stays as it is

`playerAccess/{code}` becomes world-readable and coach-writable:

```
match /playerAccess/{code} {
  allow read: if true;
  allow write: if request.auth != null && <uid owns the team that published it>;
}
```

which needs the published document to carry something linking it to a team.
**OPEN, and it conflicts with an existing rule:** a published document
deliberately carries no team code. Options: an opaque `ownerUid` (doesn't
identify the team to a reader, so it probably doesn't breach the spirit), or a
separate private index `playerAccessOwners/{code}`. Lean: the separate index —
keep the published document exactly as narrow as it is now.

## 5. The rollout, which is where the risk actually lives

Shipping rules and code together is the failure mode. A device still running
last month's build has no `uid` claim and would simply stop working, mid-match,
with no way back. PWAs update lazily; this app redeploys constantly and the
coach's own phone has been seen running an older build for weeks.

So:

- **Phase 1 — code only, rules unchanged.** Ship anonymous sign-in and
  ownership/membership *writes*. Nothing is enforced. Every existing device
  keeps working exactly as today. A team that opens with no `ownerUids` and a
  signed-in coach claims itself (safe, because today anyone with the code could
  write it anyway).
- **Phase 2 — the coach links an email.** Prompted, not forced. Until this
  happens, that coach's ownership lives only in one browser's storage, and
  clearing site data would lose it while rules are still permissive (harmless)
  but catastrophic afterwards (not). **Phase 3 must not begin for a team whose
  coach hasn't linked.**
- **Phase 3 — tighten the rules**, team subtree first, `playerAccess` second.
- **Phase 4 — org/billing**, which `entitlementsOf` already has a seam for.

Between phases, wait long enough that stale clients have updated. There is no
telemetry today to measure that with, which is itself an **OPEN** problem: a
`lastSeenBuild` per member document would answer it and costs almost nothing.

## 6. What this costs, stated plainly

- **A coach who clears site data and never linked an email loses the team.**
  After phase 3 there is no code-based recovery, by design — a recovery path
  that accepts the team code reinstates the team code as the master key. The
  honest mitigation is the existing Export backup plus "link your email", and
  the UI should be blunt about it.
- **One more thing that can fail at the worst moment.** Mitigated by
  anonymous-first and cached tokens, not eliminated.
- **Player Eval needs the same work**, since it writes `roster`. Two apps, not
  one.
- **Real effort.** Phase 1 is a day or two across three apps. Phase 3 is where
  the care goes, because it's the irreversible one.

## 7. What would make me argue against doing it

If the answer to "who is actually going to attack this" stays "nobody — it's
one high-school team and the data is who got a kill", then the current rule is
an honest match for the risk, and the real trigger for this project is the
*second organisation*, not a security event. That's a legitimate reading. The
cost of waiting is that every team onboarded before phase 1 needs the
claim-on-open path to work, which this sketch already requires.

Worth saying out loud: nothing here is urgent *today*. It is cheap to sketch
now and expensive to retrofit after there are twenty teams.
