---
'llmdispatch': minor
---

The provider conformance suite can now verify document and image handling.
`runProviderConformance` takes two further optional scenarios, `document` and `image`, plus
a `requests` map supplying the request each one dispatches. Both halves are needed: a
scenario without its request, or a request without its scenario, stays in `skipped` like
any other unverified case. A media scenario that does run has to dispatch a request
carrying a file part of that media class — `application/pdf` for `document`, an `image/*`
type for `image` — and come back complete, so a text-only request fails it rather than
passing it.
