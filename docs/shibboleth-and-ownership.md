# Shibboleth sign-in and per-instructor ownership

Notes carried over from the abandoned Rails port (`archive/ruby`), which was
started to get campus SSO and per-instructor ownership. Neither actually needed
a different language: the design below applies unchanged to `server.js`.

## Authentication

Apache does all the Shibboleth work. The app only ever trusts a header.

```js
const USER_HEADER = (process.env.TIGERQUIZ_USER_HEADER || "x-remote-user").toLowerCase();

function currentUser(req) {
  const eppn = req.headers[USER_HEADER]
    || (process.env.NODE_ENV !== "production" ? process.env.TIGERQUIZ_DEV_USER : null);
  return eppn ? store.findOrCreateUser(String(eppn)) : null;
}

function requireInstructor(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}
```

Two things make that header trustworthy, and it means nothing without both:

1. Apache unsets any `X-Remote-User` the client sent, then sets it from the
   Shibboleth session — see `deploy/apache-shibboleth.conf.example`.
2. Node binds to loopback (`HOST=127.0.0.1`), so nothing reaches it around
   Apache. The default bind is `0.0.0.0`, which is right for a classroom
   laptop and wrong the moment a proxy is supplying identity.

Which paths need a session is decided in Apache, not in the app:

| Path | Shibboleth |
| --- | --- |
| `/`, `style.css`, `sound.js`, `socket.io/`, `/quiz-images/`, `/api/nickname` | none — students join by PIN |
| `host.html`, `edit.html`, `reports.html`, everything else under `/api/` | required |

The app should still refuse instructor actions without a user, as a second line
of defence. A proxy misconfiguration should cost a 401, not a data leak.

## Data model

The port's schema, which `lib/db.js` would grow into:

| Table | Notes |
| --- | --- |
| `users` | `eppn` (from Shibboleth, unique), `display_name`, `role` (`instructor`/`admin`) |
| `quizzes` | `user_id`, `slug`, `title`, `body` (JSON: the whole quiz document as the editor already produces it) |
| `rosters` | `user_id`, `slug`, `title`, `students` (JSON) |
| `games` | as today plus `user_id` |
| `game_questions`, `game_players`, `game_answers` | as today's `questions`, `players` and `answers` tables |

Keeping the quiz document as one JSON column, rather than normalising questions
into rows, means the editor, validator and grader keep working on exactly the
shape they already know, and import and export stay trivial.

Quiz and roster slugs are unique per user, so two instructors can both have
`week-3`.

## Open question

Whether students should sign in too. If they do, the roster and nickname
machinery becomes optional because identity comes from the header. The port
deliberately kept PIN-and-nickname joining so the game worked exactly as it
does now; that is still the right default, since it is what lets a visitor join
from a phone without a campus account.
