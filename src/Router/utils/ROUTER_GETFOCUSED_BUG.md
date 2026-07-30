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
→ `onRequestResolved()` (all in `../index.js`, `router.js` and `loader.js`).

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

### The double-dispatch causes more than the crash

After fix 1 (below) stopped the crash, we kept seeing a related symptom: the Router reports a
page as active and attached, but the page's `visible` property stays `false`, so nothing renders.

The cause is the same double-dispatch, hitting a different call site. A component is always
created with `visible: false` (`components.js`); the only thing that flips it to `true` is
`executeTransition(pageIn, pageOut)` in `transition.js`, called from `loader.js`:

```js
if (!request.isSharedInstance && !request.isCancelled) {
  await executeTransition(request.page, getActivePage())
}
```

For a page's first-ever visit, `isSharedInstance` stays `false` on *both* concurrent dispatches
(that flag is only ever set in the "reuse an existing instance" branch of `loader()`, which a
fresh construction never takes), so both dispatches reach this line and call
`executeTransition` with the same `request.page`. Whichever dispatch gets there **second** now
sees `getActivePage()` already pointing at that very page — because the first dispatch already
ran `onRequestResolved()` → `setActivePage(page)` before the second one arrives. The default
(no custom transition) branch of `executeTransition` is:

```js
pageIn.visible = true
if (pageOut) {
  pageOut.visible = false
}
```

With `pageIn === pageOut`, the final assignment wins: the page ends up `visible: false` while
still fully attached, tracked, and focusable — no crash (fix 1 also keeps `cleanUp` from
touching it), just nothing on screen. This is hard evidence that the double-dispatch itself was
still happening after fix 1 — fix 1 only closed the one place (`cleanUp`) where the stale
second resolve was destructive enough to throw.

## Possible fixes

1. **Guard `cleanUp` against removing the page you're about to activate**
   (`router.js`, `onRequestResolved`): only clean up when the active page is
   not the same instance as the page being activated. Minimal, safe, no behavioral side
   effects — it stops the crash at its actual trigger point.

2. **Stop the same `Request` from ever being driven through `load()`/`loader()` twice**, so
   `handleHashChange()` re-entering for a hash that's already in flight is a true no-op rather
   than a second dispatch. This is the real root cause, not just the crash symptom — it also
   prevents the invisible-page bug above and the duplicate side effects (double
   `afterEachRoute`/page-view tracking, a duplicate data-provider network call, a duplicate
   component instance left orphaned in `Pages`). Two ways to get there:
   - make `queue()` cancel the in-flight request and replace it with a fresh one instead of
     silently no-op'ing (also incidentally fixes the `has()` vs `decodeURIComponent()` key
     mismatch), or
   - leave `queue()`'s no-op behavior alone and instead guard re-entry into the pipeline itself,
     so the original in-flight request is left completely undisturbed to finish on its own.

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

**Fix 1** — in `router.js` (`onRequestResolved`):

```js
if (getActivePage() && getActivePage() !== page && !request.isSharedInstance) {
  cleanUp(activePage, request)
}
```

This stops the crash itself, by refusing to clean up a page that's already the one being
activated.

**Fix 2** — implemented as the second option above: `queue()` in `../index.js` is untouched
(still silently no-ops when a hash is already queued). Instead, the `Request` model
(`../model/Request.js`) got a new `isDispatched` flag, defaulting to `false`. `handleHashChange()`
(`../index.js`) sets it the first time a matched-route request is handed off to the async
pipeline, right before the `beforeEachRoute` await:

```js
if (request.isDispatched) {
  return
}
request.isDispatched = true
```

If `handleHashChange()` re-enters for the same request while it's still in flight (or after
it's already resolved), it now returns immediately — no cancellation, no new request, no
re-running of `beforeEachRoute`/`route.beforeNavigate`. The original in-flight request is left
completely undisturbed to finish on its own, so it can no longer be double-dispatched into
`resolveHashChange`/`load`. This closes the crash, the invisible-page bug, and the duplicate
side effects (tracking, provider calls, orphaned component instances) described above, all from
one guard, without changing `queue()`'s existing no-op semantics for a repeat navigation to an
in-flight hash.

Fixes 3 and 5 remain open:
- Fix 3 (wrap `load(request).then(...)` in `resolveHashChange()` with `.catch()`/`.finally()`,
  both branches) still matters on its own — any other unrelated throw in that chain (not just
  this bug) would still leak the queue entry and wedge `Router.isNavigating()`.
- Fix 5 (`handleHashChange()`'s auto-queue fallback can leave `request` `undefined`) is a
  separate, narrower edge case, independent of the fixes above.
