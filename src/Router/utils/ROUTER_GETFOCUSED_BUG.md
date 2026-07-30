# `_getFocused` "must be an attached descendant" error

## The error

In production, remote logging occasionally captures:

```
Return value for _getFocused must be an attached descendant component but its ':[R]#1630'
```

The trailing number changes on every occurrence. It originates from `_getFocused()`
(`RoutedApp._getFocused()` in `../base.js`, or an app-level override that calls
`super._getFocused()`), which returns `Router.getActivePage()`.

`[R]` in the location string means the component's `__parent` is `null` — i.e. Lightning is
being told to focus a page that has been detached from the render tree. `Router.getActivePage()`
is returning a page that `Router` itself already removed from `Pages`.

## Why it occurs

The Router processes navigations as `Request` objects that move through
`navigate()` → `queue()` → `handleHashChange()` → `resolveHashChange()` → `load()` → `loader()`
→ `onRequestResolved()` (all in `../index.js` and ``).

Two things combine to cause the crash:

1. **`isSharedInstance` is a stale snapshot.** In `loader.js`, whether the incoming request
   reuses the currently active page instance (`isSharedInstance`) is computed *before* the
   `await` on the route's data provider:

   ```js
   let currentRoute = getActivePage() && getActivePage()[symbols.route]
   if (route.path === currentRoute) request.isSharedInstance = true
   ```

   If the active page changes while that provider call is in flight, this flag is wrong by
   the time the request resolves.

2. **The same `Request` object can be driven through the load pipeline twice.** `queue()`
   (`../index.js`) is meant to de-duplicate navigations to a hash that's already
   in flight:

   ```js
   const queue = (hash, args = {}, store) => {
     hash = cleanHash(hash)
     if (!navigateQueue.has(hash)) {
       ...
     }
     return false // hash already queued — no-op
   }
   ```

   But `has(hash)` is checked against the raw cleaned hash while entries are stored under
   `decodeURIComponent(hash)` — for plain hashes (no percent-encoding, e.g. `detail3/123`)
   these are identical so the de-dupe works; for encoded hashes they never match. When a
   second navigation attempt for the same in-flight hash reaches `handleHashChange()` anyway
   (e.g. two hashchange events close together, a platform re-firing hashchange, a deep link
   arriving while a request is still resolving), it fetches the *same* `Request` object from
   `navigateQueue` and independently pushes it through `resolveHashChange()` → `load()` a
   second time.

Combined, the sequence is:

1. Request R (route A → B) resolves once: `setActivePage(B)`, `activeRoute = B`.
2. The same Request R resolves a second time. `getActivePage()` is now `B`, so
   `activeRoute === request.route.path` is trivially true, and `request.isSharedInstance` is
   still `false` (computed before step 1 happened) — so `onRequestResolved` calls
   `cleanUp(activePage, request)`, which removes **B** — the page currently active and about
   to be focused — from `Pages`.
3. `setActivePage(B)` runs again, `app._refocus()` follows, and Lightning throws because `B`
   has no parent anymore.

A secondary effect: `resolveHashChange()` calls `load(request).then(() => { app._refocus(); ... })`
without a `.catch()`, and never returns that promise chain to its caller — so if `_refocus()`
throws here, it becomes an unhandled rejection and `navigateQueue.delete(queueId)` never runs.
The queue entry leaks, `Router.isNavigating()` stays `true` forever, and further navigation to
that hash keeps hitting the same stale request.

## Possible fixes

1. **Guard `cleanUp` against removing the page you're about to activate**
   (`router.js`, `onRequestResolved`): only clean up when the active page is
   not the same instance as the page being activated. Minimal, safe, no behavioral side
   effects — it stops the crash at its actual trigger point.

2. **Make `queue()` cancel-and-replace instead of silently no-op'ing** when a hash is already
   in flight (`../index.js`). This prevents the same `Request` object from ever being
   driven through `load()`/`loader()` twice concurrently — the real root cause, not just the
   crash symptom. It also incidentally fixes the `has()` vs `decodeURIComponent()` key
   mismatch. This is a larger, deliberate behavior change (a repeat navigation to an in-flight
   hash now restarts instead of being dropped), so it needs a bit more soak time.

3. **Stop swallowing the rejection in `resolveHashChange()`**: wrap the `load(request).then(...)`
   chains (both the direct-component and dynamic-import branches) with `.catch()`/`.finally()`
   so a single throw can't leak the queue entry and wedge `Router.isNavigating()`.

4. **App-side defensive guard in `_getFocused()`**: in the consuming app (or in
   `RoutedApp._getFocused()` here in the SDK base class), detect a returned page with no
   `.parent`, log it, and fall back to `undefined`/re-attach instead of letting Lightning
   throw. This doesn't address the root cause but turns a crash into a recoverable state and
   is useful as a diagnostic if the other fixes are deferred.

5. **Guard `handleHashChange()`'s auto-queue fallback** (`../index.js`): currently
   `if (!request && !navigateQueue.size) { request = queue(hash) }` leaves `request` as
   `undefined` (causing a `TypeError` on the next line) if the queue is non-empty but doesn't
   contain this particular hash. Worth tightening alongside fix 2.

## What we've done

Only **fix 1** has been implemented so far, in `router.js`
(`onRequestResolved`):

```js
if (getActivePage() && getActivePage() !== page && !request.isSharedInstance) {
  cleanUp(activePage, request)
}
```

This stops the crash itself. It does **not** address the underlying double-resolve: the rest
of `onRequestResolved` (component storage, `emit('mounted'/'changed')`, widget updates,
`afterEachRoute` — including page-view tracking) can still run twice for the same navigation,
and duplicate page instances can still be created if a route's component gets constructed
twice. Fixes 2, 3 and 5 remain open if that class of duplication needs to be closed too.
