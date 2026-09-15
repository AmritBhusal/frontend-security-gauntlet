# Frontend Security: Things We Get Wrong

Most frontend teams genuinely care about security. Yet the same handful of mistakes keep showing up, not because people are careless, but because a few of these ideas are easy to half understand. Here's a walk through the ones that come up again and again.

## XSS and the Same Origin Rule

Browsers keep websites separate using the same origin policy: one site's code can't normally touch another's data. XSS (cross site scripting) breaks that wall by tricking your site into running an attacker's code as if it were your own.

It only takes two things going wrong at once: your page accepts text from an outside source, and it displays that text without cleaning it first. When both happen, the attacker's code can read everything on the page, grab stored data, and send requests as the logged in user.

## "React Prevents XSS": Only Partly True

React's JSX automatically encodes any value you insert, so it can't accidentally turn into runnable HTML. That covers the common case of showing plain text.

But escaping is contextual, not universal. Attributes, scripts, and styles each follow their own rules. There's a sneaky trap here too: an unquoted attribute can still run code (`onmouseover=alert(1)`), even if quotes are handled correctly everywhere else.

Two defenses actually hold up:

1. **Sanitize by default.** If raw HTML has to be rendered, use a vetted library like DOMPurify rather than a homemade cleaner.
2. **CSP.** A backup layer, not your main line of defense.

## Content Security Policy (CSP), Done Right

CSP tells the browser what code is allowed to run, so the damage is limited if XSS ever does get through.

Avoid allowlist CSPs (listing approved domains). They're hard to maintain and break the moment a third party script changes something. A strict CSP, built on nonces or hashes, works better. It blocks inline event handlers, `eval()`, object embeds, and `<base>` tag hijacking.

**Rolling it out in five steps:**

1. Test with `Content-Security-Policy-Report-Only` first.
2. Pick nonces for dynamic pages or hashes for static content.
3. Turn on the strict policy for real.
4. Add `strict-dynamic` for scripts that load other scripts.
5. Fix whatever breaks, usually inline handlers, by switching to `addEventListener`.

If a strict policy isn't realistic yet, fall back to `default-src https:`. Just never reach for `unsafe-inline`, `data:` URIs in `script-src`, or wildcard sources.

## What's Hiding Inside Your Shipped Code

Anything reachable in shipped code is information leakage, basically a free map handed to attackers. Three things worth checking regularly:

- **Hardcoded secrets**: credentials or database strings typed straight into JS.
- **Weakly scoped API keys**: exposed keys should be restricted by IP, referrer, or API.
- **Leaked internal routes**: admin URLs or internal IPs left sitting in config objects.

## Source Maps

Source maps turn minified JS back into readable code. Check for `file.js.map` sitting next to `file.js`. And remember: minifying isn't the same as hiding. Text and strings survive just fine; only variable names shrink.

- Decide on purpose whether maps ship publicly, or send them privately to tools like Sentry instead.
- Grep shipped code for secrets, and check key scoping on a regular basis.

## Auth and the Session Boundary

- **CSRF** tricks a browser into sending a real, authenticated request the user never meant to send. Fix it with CSRF tokens plus `SameSite` cookies.
- **Token storage matters.** `localStorage` is readable by JS, which means XSS can read it too. An `httpOnly` cookie can't be read by JS at all.
- **Cookies vs. localStorage:** cookies can be locked down with `httpOnly`, `Secure`, and `SameSite`. localStorage has none of those protections. Use cookies for auth.
- **Client side authorization** is a UI convenience, not real security. Hiding a button doesn't block the action; always recheck permissions on the server.

## What the Browser and Network Expose

- **CORS**: a misconfigured header lets any site read data meant only for yours. Allow only trusted origins, and never mix a wildcard `*` with credentials.
- **Exposed env vars**: build tools can bake "secret" variables straight into public JS. Only mark values public if they're genuinely fine to be public.
- **URL manipulation**: editing IDs in a URL can expose someone else's data if the backend doesn't recheck permissions.
- **Open redirects**: a redirect that accepts any URL can send users straight to a phishing page. Only redirect to a trusted allowlist.

## What We Didn't Write Ourselves

Most of a modern frontend is dependency code, and it runs with the same trust as your own. Risk creeps in through compromised packages, typo squatted names (`reqeust` instead of `request`), or transitive dependencies you never chose directly.

**Keep it in check:**

- Pin versions and review updates before merging.
- Run automated vulnerability scans in CI.
- Use lockfiles for exact, repeatable installs.
- Keep the dependency list as small as the task allows.

## Before You Ship

- Sanitize raw HTML. Don't rely on React alone.
- Move to a strict, nonce or hash based CSP.
- Grep production JS for secrets, and check for source map exposure.
- Store tokens in `httpOnly` cookies, not `localStorage`.
- Recheck permissions server side, never just in the UI.
- Pin dependencies and scan them in CI.

None of these fixes are hard on their own. What makes frontend security tricky is that the mistakes hide in plain sight. Once you know where to look, checking takes minutes, not weeks.
