# Types without a build step

tigerquiz is plain JavaScript and stays that way. TypeScript is installed as a
*checker only*: `npm run typecheck` runs `tsc` with `checkJs` and `noEmit`, so
every file is checked in place and nothing is compiled. `node server.js` is
still the whole deploy, and `Dockerfile` still copies `.js` files verbatim.

This was a deliberate choice over converting the tree to `.ts`:

- The codebase is about 3,600 lines across eight files. A conversion is
  affordable but the payoff over annotated JS is small at this size.
- Zero-build is load-bearing. The image is digest-pinned with no toolchain
  because `node:sqlite` is a built-in; adding a compile step to the deploy path
  is the thing that config was written to avoid.
- `public/edit.js` is 604 lines of browser code with no bundler. It cannot be
  `.ts` without introducing one, but `checkJs` covers it for free.
- Node 26 does run `.ts` directly by stripping types, but stripping is not
  checking — `tsc --noEmit` would still run in CI. Same checker, same config,
  plus a rename of every file and a restriction to erasable syntax.

Revisit if `server.js` roughly doubles, or if more than one person is
committing regularly. Neither is true today.

## Writing types

Annotate with JSDoc, which `tsc` reads as fully as it reads TypeScript:

```js
/**
 * @param {string} pin
 * @param {{ name: string, score: number }} player
 * @returns {boolean}
 */
function addPlayer(pin, player) { ... }
```

Cast with a parenthesised type comment when the checker cannot see what you
know:

```js
const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
```

Define shared shapes once with `@typedef` and import them across files with
`import("./questions.js").Question`.

## The ratchet

TypeScript 7 enables `strict` by default, so `tsconfig.json` turns it off and
switches individual checks back on. Everything currently on passes with zero
errors, and CI enforces that. What is still off, with the cost of turning it on
measured at the commit that added this file:

| Flag | Errors today | Notes |
| --- | --- | --- |
| `noImplicitReturns` | 12 | Smallest next step |
| `useUnknownInCatchVariables` | 26 | Mostly `catch (e)` reaching for `e.message` |
| `strictNullChecks` | 87 | The one that finds real bugs; do it before `noImplicitAny` |
| `noImplicitAny` | 436 | The bulk of the annotation work, and the least urgent |

Enable one, drive it to zero, commit. Do not add `// @ts-ignore` to make a flag
pass — that trades a checked error for an unchecked one.

`noUnusedLocals` and `noUnusedParameters` stay off for a different reason: the
browser scripts are classic scripts, not modules, so a global like `Sound` in
`public/sound.js` is consumed by an inline `<script>` in `host.html` and looks
unused to the checker. Turning them on would mean silencing that legitimately.
