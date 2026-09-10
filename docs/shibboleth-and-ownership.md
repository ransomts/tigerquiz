# Shibboleth sign-in and per-instructor ownership

Implemented. This describes how it works and how to turn it on.

## Switching it on

Sign-in is **off by default**, so `npm start` on a classroom laptop and the
Docker image behave as they always have: one unnamed teacher who owns nothing
and sees everything. Set `TIGERQUIZ_AUTH=required` to turn it on, and put
Apache in front as `deploy/apache-shibboleth.conf.example` shows.

Developing without a proxy: `TIGERQUIZ_AUTH=required TIGERQUIZ_DEV_USER=you@example.edu npm start`.
`TIGERQUIZ_DEV_USER` is ignored when `NODE_ENV=production`, so a stray value in
a deployed environment cannot become a way in.

## Authentication

Apache does all the Shibboleth work; the app never speaks SAML. `mod_shib`
terminates the session and passes an identity in one header, which `lib/auth.js`
reads and nothing else.

Two things make that header trustworthy, and **it is worth nothing without
both**:

1. Apache unsets any `X-Remote-User` the client sent, then sets it from the
   Shibboleth session.
2. Node binds to loopback (`HOST=127.0.0.1`), so nothing can reach it around
   Apache.

Drop either and anyone who can reach the port is anyone they care to name.

Which paths need a session is decided in Apache, and again in the app as a
second line: a proxy misconfiguration should cost a 401, not the class list.

| Path | Session |
| --- | --- |
| `/`, `style.css`, `sound.js`, `socket.io/`, `/quiz-images/`, `/api/nickname`, `/api/me` | none — students join by PIN |
| `host.html`, `edit.html`, `reports.html`, everything else under `/api/` | required |

`/api/qr.svg` is in the protected group: only the host screen ever asks for a
QR code, students merely scan it.

Students do not sign in. That is deliberate — it is what lets somebody join
from a phone without a campus account, and the roster still identifies them by
name or student ID when a game is played against a class list.

## Ownership

Quizzes and class lists stay as JSON files under `quizzes/`, so hand-editing,
git and the Docker bind mount all keep working. A single `owners` table records
which eppn owns each file; `games.owner` does the same for reports.

Three states, and the rules follow from them:

| State | Who sees it | Who can change it |
| --- | --- | --- |
| Owned by you | you | you |
| Owned by someone else | nobody else | nobody else |
| Unowned | every instructor | nobody, until claimed |

- **Saving something new makes it yours.** There is no separate create step.
- **Unowned means shared and read-only.** The quizzes shipped with the app,
  anything dropped into `quizzes/` by hand, and every report from before
  sign-in existed start here. One click claims it.
- **Refusals do not confirm existence.** Anything you may not read reports 404,
  never 403, so a listing cannot be used to enumerate other people's work.
  403 is reserved for things you *can* see but may not change — the unowned
  ones — and it carries `claimable: true` so the editor can offer the button.
- **Hosting is gated too.** Creating a game over the websocket checks the quiz
  and class list the same way the HTTP API does; the handshake carries the same
  header, because it goes through the same proxy.

An `admin` role exists in the `users` table and passes every check. Nothing
sets it yet — promote by hand with SQL when you need one.

## What is not done

- No admin page. Listing every user, promoting one, or reassigning an owner is
  a SQL statement today.
- Ownership cannot be transferred, only claimed when unowned. Releasing
  something back to unowned means `DELETE FROM owners WHERE ...`.
- `tools/check-quizzes.mjs` validates every file on disk regardless of owner,
  which is right for a pre-lesson check run by whoever administers the box.
