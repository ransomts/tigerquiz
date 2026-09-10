# tigerquiz

A small self-hosted live quiz game in the style of Kahoot. One host screen on the
projector, players join from their phones with a PIN, fastest correct answer scores most.

## Try it

There is a live instance at **[brgr.cecas.clemson.edu/quiz/](https://brgr.cecas.clemson.edu/quiz/)**.

| Page | Who can open it |
| --- | --- |
| [Join a game](https://brgr.cecas.clemson.edu/quiz/) | Anyone — this is what students see |
| [Host screen](https://brgr.cecas.clemson.edu/quiz/host.html) | Password |
| [Editor](https://brgr.cecas.clemson.edu/quiz/edit.html) | Password |
| [Reports](https://brgr.cecas.clemson.edu/quiz/reports.html) | Password |

It is served from a sub-path behind nginx with the teacher pages under basic
auth, which is the arrangement [Behind a reverse proxy](#behind-a-reverse-proxy)
and [Locking it down](#locking-it-down) describe. Ask for the password if you
want to run a game rather than play in one.

## Run

```sh
npm install
npm start          # http://localhost:3000
```

Needs Node 26 or newer, which is what `.node-version` records and what CI and
the Docker image use. `node:sqlite` is a built-in, so there is nothing to
compile and no database to install.

[docs/teaching-with-tigerquiz.md](docs/teaching-with-tigerquiz.md) walks through
one lesson from start to finish, with screenshots.

- Host screen: `http://<your-ip>:3000/host.html`
- Players: `http://<your-ip>:3000/` and enter the PIN (or `/?pin=123456`)
- Editor: `http://<your-ip>:3000/edit.html`
- Reports: `http://<your-ip>:3000/reports.html`

Open the host screen by network name or IP, not `localhost`. The PIN and QR code
that students see are built from the address in your browser bar, so a localhost
address gives them a link they cannot reach. The lobby warns you when it spots this.

Set `PORT` to change the port. Everyone must be able to reach the host machine on that
port (same Wi-Fi, or put it behind a reverse proxy). `HOST` sets the bind address and
defaults to `0.0.0.0`; set it to `127.0.0.1` when a proxy in front supplies the
identity header, so nothing can reach the app around the proxy.

```sh
npm run lint       # eslint
npm run test:unit  # scoring, validation and the join throttle, in process
npm test           # plays full games over websockets against a throwaway database
npm run test:auth  # sign-in and per-instructor ownership
npm run check      # validate every quiz and class list before a lesson
npm run typecheck  # type-check the JavaScript in place; no build step
npm run coverage   # line coverage of the pure logic
```

The code is plain JavaScript and stays that way — `npm run typecheck` runs
TypeScript as a checker over the `.js` files without compiling anything. See
[docs/typing.md](docs/typing.md) for how to annotate and what is still switched
off. All four commands run in CI on every push, which is what makes the weekly
Dependabot upgrade PRs safe to merge on a glance.

### How the code is laid out

`server.js` is wiring only. The pieces it assembles:

| File | What it holds |
| --- | --- |
| `lib/config.js` | Paths and tunables read from the environment |
| `lib/auth.js` | Who is asking, and what they may touch |
| `lib/content.js` | Reading and writing quizzes and class lists on disk |
| `lib/routes.js` | The HTTP API the teacher's browser calls |
| `lib/room.js` | One live game: players, clock, scoring, rewind |
| `lib/registry.js` | Every open game, and the host keys that create them |
| `lib/sockets.js` | The websocket messages, for hosts and players |
| `lib/questions.js` | Question types: validation, presentation, grading |
| `lib/db.js` | The SQLite report store |

`Room` takes socket.io as a constructor argument rather than importing it, so a
game can be driven without a server attached.

## Docker

```sh
docker build -t tigerquiz .
docker run -p 3000:3000 \
  -v "$PWD/quizzes:/app/quizzes" \
  -v "$PWD/data:/app/data" \
  tigerquiz
```

Mount both directories. The editor writes quizzes and class lists back to
`quizzes/`, and `data/` holds the report database; without the mounts, both are
lost when the container is replaced. `docker-compose.example.yml` is the same
thing for compose.

## Behind a reverse proxy

tigerquiz can be served from a sub-path, so
[`https://brgr.cecas.clemson.edu/quiz/`](https://brgr.cecas.clemson.edu/quiz/)
works without giving it a hostname of its own. The pages work out which prefix they
are under from their own URL, so there is nothing to set in the app: the join
link and QR code shown to students pick up the prefix on their own.

Strip the prefix before the request reaches the app, pass the websocket
through, and keep the timeout longer than a lesson. In nginx:

```nginx
location = /quiz { return 301 /quiz/; }

# "^~" so a regex location for *.js and *.css cannot claim these first. Nginx
# checks regex locations before plain prefix ones, so without it a proxy that
# caches static assets will send style.css and the socket.io client somewhere
# else, and the symptom is an unstyled page rather than an error.
location ^~ /quiz/ {
    # the trailing slash on proxy_pass is what strips /quiz
    proxy_pass http://tigerquiz:3000/;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header Host $host;

    # a game holds one websocket open for the whole lesson
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

## Locking it down

tigerquiz has no login of its own. On a classroom network that is usually
fine. Somewhere reachable from the internet it is not: the reports and class
lists carry student names and identifiers, and `/api/quiz/<id>` returns the
answer key, which any student could fetch mid-game.

There is a clean split between what a player needs and what only the teacher
needs, so the proxy can ask for a password on the second group:

| Public | Teacher only |
| --- | --- |
| `/`, `style.css`, `sound.js` | `host.html`, `edit.html`, `reports.html` |
| `socket.io/`, `/quiz-images/` | everything under `/api/` |
| `/api/nickname` | |

Protect the whole of `/api/` and carve `/api/nickname` back out, rather than
listing the endpoints to protect. That way an endpoint added later is covered
by default instead of being exposed until somebody notices. With nginx:

```nginx
location ^~ /quiz/api/ {
    auth_basic "tigerquiz";
    auth_basic_user_file /path/to/htpasswd;
    # ...same proxy settings as above
}

# the dice button on the join screen suggests a nickname
location = /quiz/api/nickname {
    # ...same proxy settings as above, no auth_basic
}
```

An exact `=` match wins over a `^~` prefix, which is what lets the one public
endpoint sit inside the protected tree.

Creating a game arrives over the websocket, which is one endpoint shared by
hosts and players, so a proxy cannot split it by path. Instead the host page
first fetches a short-lived key from `/api/host-key` over ordinary HTTP, and
passes it back when it creates the game. Protecting `/api/` therefore protects
game creation too, with nothing extra to configure. Without a proxy in front,
the endpoint is open and nothing changes.

`MAX_ROOMS` caps how many games can be open at once, and `HOST_KEY_TTL_MS` how
long a key stays valid.

One thing none of this covers: browsers hold basic-auth credentials until the
window closes, so close the browser on a shared podium machine rather than just
the tab.

The [live instance](https://brgr.cecas.clemson.edu/quiz/) is configured exactly
this way, so it doubles as a worked example: the join screen and the nickname
endpoint answer to anyone, while
[`host.html`](https://brgr.cecas.clemson.edu/quiz/host.html),
[`edit.html`](https://brgr.cecas.clemson.edu/quiz/edit.html),
[`reports.html`](https://brgr.cecas.clemson.edu/quiz/reports.html) and
everything under `/api/` return 401 until you give it the password.

## Campus SSO and per-instructor ownership

Basic auth is one shared password for everyone who teaches. Where the
institution runs Shibboleth, Apache can terminate SAML instead and hand the app
a verified identity — and then quizzes, class lists and reports belong to
whoever made them.

**This is off by default.** Without it the app behaves exactly as it always
has: one unnamed teacher who owns nothing and sees everything, which is what a
laptop on a classroom projector wants. Turn it on with `TIGERQUIZ_AUTH=required`
and put Apache in front.

None of it reaches the application code: `mod_shib` does the SAML, and the app
reads one request header. `deploy/apache-shibboleth.conf.example` is a working
virtual host — TLS, the websocket proxy, which paths need a session, and the two
`RequestHeader` lines that make the header trustworthy. Pair it with
`HOST=127.0.0.1` so the app cannot be reached around Apache: the header is
forgeable by anyone who can reach the port directly, and the config is worth
nothing without that.

Quizzes and class lists stay as files in `quizzes/`, so everything below about
hand-editing still works. A table records who owns each one:

| State | Who sees it | Who can change it |
| --- | --- | --- |
| Owned by you | you | you |
| Owned by someone else | nobody else | nobody else |
| Unowned | every instructor | nobody, until claimed |

Saving something new makes it yours. The samples that ship with the app and
files dropped into `quizzes/` by hand start unowned: shared, read-only, and
claimable with one click in the editor.

**Reports are the exception, deliberately.** A quiz nobody owns is worth
sharing; a report nobody owns holds a class's names, student IDs and every
answer they gave, so it is shared with nobody but an admin. That means reports
recorded before sign-in was switched on go invisible until they are handed to
someone — do that first:

```sh
node tools/assign-owner.mjs --user you@example.edu --reports --dry-run
node tools/assign-owner.mjs --user you@example.edu --reports
```

Students never sign in. They join by PIN from any phone, which is the point.

`deploy/tigerquiz.service` runs the app under systemd and
`deploy/tigerquiz.env.example` is the environment file it reads.
[docs/shibboleth-and-ownership.md](docs/shibboleth-and-ownership.md) has the
details, including what is deliberately left to SQL.

## Writing quizzes

The easiest way is the editor at `/edit.html`. It lists your quizzes and class
lists, edits every question type with the right fields for each, checks your work
as you type, and saves back to `quizzes/`. It can also import questions you already
have, either as pasted text or as CSV:

```
Which planet is red?
- Venus
* Mars
- Jupiter
```

Blank lines separate questions and `*` marks the correct answer. Prefix a line with
`T/F` for a true or false question. The CSV form takes a `question` column, up to
four `choice` columns, and an `answer` column numbered from one.

Everything below describes the file format, which you only need if you would rather
write it by hand. Drop a JSON file in `quizzes/`. The filename becomes the quiz id.

```json
{
  "title": "My Quiz",
  "identifier": "Student ID",
  "shuffleQuestions": false,
  "shuffleAnswers": true,
  "questions": [
    { "text": "Which planet is red?", "choices": ["Venus", "Mars"], "answer": 1, "time": 20 }
  ]
}
```

Quiz-level fields:

| Field | Meaning |
| --- | --- |
| `title` | Shown on the host screen and in reports |
| `identifier` | If set, players are asked for this alongside a nickname, and it lands in the report |
| `shuffleQuestions` | Randomise question order for each game |
| `shuffleAnswers` | Randomise choice order, except for true/false |
| `phoneText` | Mirror the question and choices onto phones, on by default. Set `false` for the classic projector-only look |

Every question takes `text`, an optional `time` in seconds, and an optional `image`
naming a file in `quizzes/images/` or an `http(s)` URL. Two more are worth setting
on anything you actually teach with:

| Field | Meaning |
| --- | --- |
| `explanation` | Shown to everyone once the answer is revealed, and kept in the report. This is what turns a wrong answer into something learned, so `npm run check` warns when it is missing |
| `discuss` | Marks a question as worth a peer-instruction round, highlighting the re-vote button on the host screen |

The rest depends on `type`.

### Question types

| `type` | Extra fields | Scoring |
| --- | --- | --- |
| `choice` (default) | `choices` (2-4), `answer` index | Right or wrong |
| `truefalse` | `answer` as `true` or `false` | Right or wrong |
| `multi` | `choices`, `answers` array of indexes | Partial credit, wrong picks cancel right ones |
| `slider` | `min`, `max`, `step`, `answer`, `tolerance`, `unit` | Full marks inside the tolerance, tapering to zero |
| `text` | `accept` array of allowed answers, `fuzzy` | Right or wrong, ignoring case, accents and light typos |
| `order` | `items` in the correct order | Partial credit per item placed correctly |
| `poll` | `choices` | Unscored, results shown as a bar chart |
| `wordcloud` | `maxWords` up to 5 | Unscored, results shown as a word cloud |
| `slide` | none | Nothing to answer, the host advances past it |

`quizzes/all-types.json` demonstrates all nine.

Quizzes are validated when a game is created. A bad answer index or a malformed
question is reported on the host screen instead of failing mid-game.

## Class lists

Use the editor, or put a roster in `quizzes/rosters/` by hand:

```json
{
  "title": "Period 3 Biology",
  "students": [
    { "name": "Ada Lovelace", "id": "1001" },
    { "name": "Alan Turing", "id": "1002" }
  ]
}
```

A plain array of names works too. Pick a class list when creating a game and players
must identify themselves as somebody on it, by name or by id. Matching ignores case,
spacing and punctuation. The report then names anyone who never played.

## Scoring

Correct answers earn up to 1000 points, scaled down linearly to 500 for an answer
given at the last moment. Partial credit types scale that further. Wrong or missing
answers earn 0.

Consecutive correct answers build a streak. The second correct answer in a row adds a
100 point bonus, the third 200, and so on up to 500. One wrong answer resets it. Polls
and word clouds leave a streak untouched, since they have no right answer.

Players see their streak, their rank movement, and the gap to the player just ahead.

## Running a game

The host screen has the controls. Space or Enter advances, the left and right
arrow keys move between questions, and `P` pauses.

- **Pause** stops the clock for everyone and refuses answers until you resume.
  Paused time is not counted against anyone's response speed.
- **Back** replays the previous question, or on a results screen re-asks the one
  just shown. Replaying rewinds every score and streak to what they were before
  that question, so nobody is paid twice for the same answer.
- **Jump to** opens any question directly. Skipping forward simply leaves the
  skipped questions unanswered.

If the host's browser disconnects, the game is paused and held open for three
minutes rather than destroyed, and players are told the host is away. Reopening
the host page rejoins the same game automatically and puts the screen back where
it was. Set `HOST_GRACE_MS` to change how long a game waits.

## Checking quizzes

```sh
npm run check              # every quiz and class list
npm run check -- my-quiz   # one quiz, by id or path
```

Errors are things that would break a game: a bad answer index, duplicate choices,
a missing image, a slider answer outside its own range. Warnings are things that
are legal but usually mistakes, such as a two second timer, a repeated question,
or a class list with two students whose names cannot be told apart. The command
exits non-zero if there are any errors, so it works in a pre-commit hook.

## Teaching with it

**Explanations.** Set `explanation` on a question and it appears on the host screen
and on every phone the moment the answer is revealed, then again in the report.
Students who got it wrong find out why while they still care.

**Peer instruction.** After a question, the host screen offers "Discuss & re-vote"
whenever the class was split, or always for a question marked `discuss`. It re-asks
the same question, keeping the first vote, and the results then show both rounds
side by side with a line reading how many were correct before and after. Scores
come from the second vote, not both, so discussing cannot inflate anyone's total.

**What people chose.** The report breaks every question down by the answer people
actually picked, marks the correct one, and names the wrong answer the class landed
on. A correct rate tells you a question was hard. The distractor tells you what they
believe instead. A single stray pick is not called out, since one person is not a
pattern.

**Rehearsing.** "Rehearse this quiz alone" on the setup screen runs a quiz with no
players, so you can check it before a lesson. Rehearsals produce no report.

**Playing again.** After the final standings, "Play again, same players" restarts the
same quiz with everyone still in the room and scores back to zero. It is recorded as a
separate game.

**Review quizzes.** "Make a review quiz" on a report writes a new quiz containing
the questions that class did worst on, ordered worst first, with explanations kept.
It lands in `quizzes/` and shows up in the host list, so the next lesson can open
with spaced retrieval of exactly what was missed. Questions are matched back to the
original file by their recorded position, so answer shuffling does not confuse it.

## Nicknames

Nicknames are screened against a word list before anyone joins. Disguises are
collapsed first, so `sh1t` and `a$$` are caught, and ordinary words that happen to
contain a blocked run are allowed, so `Cassidy`, `classic` and `Scunthorpe` all get
through. Players can press the dice button for a suggested name instead of inventing
one. No list is complete, so the host can still remove anyone from the lobby with a
click. Add your own words, one per line, in `quizzes/blocked-words.txt`.

## Reports

Every finished game is saved to `data/tigerquiz.db`, a SQLite file. Open
`/reports.html` for the list.

Each report shows the class average, the questions fewer than half the class got right,
a per-question breakdown with correct rate and average response time, and a per-player
table with scores and identifiers. "Download CSV" gives one row per player per question,
for grading or a spreadsheet.

Games the host abandons before the final standings are discarded rather than saved.
Set `TIGERQUIZ_DATA` to store the database somewhere else.

## Guessing a PIN

A game PIN is six digits, so there are 900,000 of them and a script can try a
lot of them quickly. Unthrottled, one connection managed about 3,400 lookups a
second here, which is the whole space in roughly four minutes — enough to list
the title of every lesson running and walk into any game not gated by a class
list.

Wrong guesses are therefore rate-limited: twenty to start with, then one back
every ten seconds. That leaves the same sweep taking about three months, while
costing a real student nothing, because **only wrong guesses are charged**. That
distinction matters more than it looks: a class usually shares one address, so
charging every attempt would throttle the room rather than the intruder.

Behind a proxy, set `TIGERQUIZ_TRUST_PROXY=true` so the throttle can tell
clients apart — every socket arrives from `127.0.0.1` otherwise, and one
attacker would spend everybody's budget. Only set it when a proxy really is in
front: without one, a client can invent the header and hand itself a fresh
budget. `TIGERQUIZ_JOIN_BURST` and `TIGERQUIZ_JOIN_REFILL_MS` tune it.

A class list is still the stronger control, since it rejects anyone not on it
by name or ID.

## Restarts

Live games are held in memory, so stopping the server ends every game running
on it. That is unchanged, but it is no longer silent: on `SIGTERM` the server
tells each open game it is going away, so phones and projectors show a message
rather than hanging, then checkpoints the database and exits. A crash is
handled the same way and logged, instead of vanishing with the games.

`deploy/tigerquiz.service` allows fifteen seconds for that.

## Backups

`data/tigerquiz.db` holds every report — student names, identifiers, and each
player's answer to each question. Nothing else in the checkout is irreplaceable,
and nothing backs it up on its own.

```sh
deploy/backup.sh /srv/tigerquiz/data /srv/backups
```

Do not simply copy the file. The database runs in WAL mode, so at any moment
some committed reports live in `tigerquiz.db-wal` and not yet in
`tigerquiz.db`: copying the `.db` alone can lose the most recent games, and
copying the three files separately can catch them mid-checkpoint and produce a
backup that will not open. The script uses SQLite's `VACUUM INTO`, which takes a
consistent snapshot of a live database without blocking the running server, then
verifies it opens and prunes anything older than 30 days.

Cron it daily:

```
17 3 * * *  /srv/tigerquiz/deploy/backup.sh /srv/tigerquiz/data /srv/backups
```

## Host screen

- A QR code in the lobby encodes the join link, so players can scan instead of typing.
- Sound effects (question start, final five seconds, time up, answer reveal, podium
  fanfare) are synthesized in the browser, no audio files needed. Toggle them with the
  button in the footer; the choice is remembered.
- The game ends on an animated podium revealing third, second, then first place.

## Notes

- Live game state lives in memory; restarting the server ends games in progress.
- A dropped host can rejoin, but a restarted server cannot be rejoined.
- Finished games are saved to disk and survive a restart.
- Players who refresh mid-game rejoin under the same nickname automatically.
- Closing the host tab ends the game for everyone.
- Sound needs a click before it can play, so the host must press "Create game" (any
  click works) before the first question. This is a browser autoplay rule.

## License

tigerquiz is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE).

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.
