# tigerquiz

A small self-hosted live quiz game in the style of Kahoot. One host screen on the
projector, players join from their phones with a PIN, fastest correct answer scores most.

This is the Ruby on Rails version, built to sit behind a department's Apache and
Shibboleth single sign-on. Instructors sign in; students just need the PIN. The
original Node version lives on the `main` branch, and `PORT.md` records how and why
it was ported.

## Run it on your own machine

Needs Ruby 3.2 or newer with its headers (`ruby-dev` on Debian and Ubuntu) and a
C compiler.

```sh
bundle config set --local path vendor/bundle   # only if you cannot install gems system-wide
bin/setup                                      # installs gems, prepares the database, starts the server
```

That starts the app at `http://localhost:3000` signed in as a developer user who
owns the sample quizzes from `quizzes/`.

- Host screen: `http://<your-ip>:3000/host`
- Players: `http://<your-ip>:3000/` and enter the PIN (or `/?pin=123456`)
- Editor: `http://<your-ip>:3000/edit`
- Reports: `http://<your-ip>:3000/reports`

Open the host screen by network name or IP, not `localhost`. The PIN and QR code
that students see are built from the address in your browser bar, so a localhost
address gives them a link they cannot reach. The lobby warns you when it spots this.

```sh
bin/rails test        # the whole suite, including full games played through the engine
bin/test-lib          # only the pure logic tests, no Rails needed
bin/check             # validate every quiz file and class list in quizzes/
node tools/smoke.mjs  # play a game over real websockets against a running server
```

Outside production, `TIGERQUIZ_DEV_USER` names the signed-in instructor when there
is no single sign-on header. It defaults to `developer` in development.

## Deploy it for a department

The app runs as one Puma process behind Apache. Apache terminates TLS, handles
Shibboleth, and passes the signed-in user's identity to the app in a header. The
app keeps every running game in memory, which is why there is exactly one process.
See `PORT.md` for the reasoning.

1. Check the code out, say at `/srv/tigerquiz`, owned by a `tigerquiz` user.
   Run `bundle install`, `RAILS_ENV=production bin/rails db:prepare` and
   `RAILS_ENV=production bin/rails assets:precompile`.
2. Copy `config/deploy/tigerquiz.env.example` to `/etc/tigerquiz.env`, put a real
   `SECRET_KEY_BASE` in it (`bin/rails secret`), and install
   `config/deploy/tigerquiz.service` with systemd.
3. Adapt `config/deploy/apache.conf.example`: the host name, the certificate, and
   which Shibboleth attribute or group marks an instructor. It proxies to Puma's
   Unix socket, upgrades `/cable` to a websocket, sets `X-Remote-User` from the
   Shibboleth session, and requires a session only on instructor paths. Students'
   phones never sign in.
4. Open `https://quiz.example.edu/api/me` in a browser. It shows who the app thinks
   you are, which is the quickest check that the header wiring is right.
5. Import any quiz files: `RAILS_ENV=production bin/rails 'quizzes:import[you@example.edu]'`.

The database is `storage/production.sqlite3`. Back it up with
`sqlite3 storage/production.sqlite3 ".backup /somewhere/tigerquiz.sqlite3"`, which
is safe while the app is running. Question images live in `quizzes/images/` or in
the directory `TIGERQUIZ_IMAGES` names.

Every instructor sees only their own quizzes, class lists and reports.

## Writing quizzes

The easiest way is the editor at `/edit`. It lists your quizzes and class lists,
edits every question type with the right fields for each, checks your work as you
type, and saves. It can also import questions you already have, either as pasted
text or as CSV:

```
Which planet is red?
- Venus
* Mars
- Jupiter
```

Blank lines separate questions and `*` marks the correct answer. Prefix a line with
`T/F` for a true or false question. The CSV form takes a `question` column, up to
four `choice` columns, and an `answer` column numbered from one.

Everything below describes the JSON format, which you only need if you would rather
write quizzes by hand and import them. Drop a file in `quizzes/`; the file name becomes
the quiz's short name.

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
naming a file in the images directory or an `http(s)` URL. Two more are worth setting
on anything you actually teach with:

| Field | Meaning |
| --- | --- |
| `explanation` | Shown to everyone once the answer is revealed, and kept in the report. This is what turns a wrong answer into something learned, so `bin/check` warns when it is missing |
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

Quizzes are validated when saved and when a game is created. A bad answer index or a
malformed question is reported in the editor instead of failing mid-game.

## Class lists

Use the editor, or write a roster by hand in `quizzes/rosters/` and import it:

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
it was. A player whose phone drops gets the open question back when it reconnects.
Set `HOST_GRACE_MS` to change how long a game waits.

## Checking quiz files

```sh
bin/check                    # every quiz file and class list in quizzes/
bin/check my-quiz            # one quiz, by short name or path
bin/rails quizzes:check      # the same, through Rails
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
It shows up in the host list, so the next lesson can open with spaced retrieval of
exactly what was missed. Questions are matched back to the original by their
recorded position, so answer shuffling does not confuse it.

## Nicknames

Nicknames are screened against a word list before anyone joins. Disguises are
collapsed first, so `sh1t` and `a$$` are caught, and ordinary words that happen to
contain a blocked run are allowed, so `Cassidy`, `classic` and `Scunthorpe` all get
through. Players can press the dice button for a suggested name instead of inventing
one. The host can remove anyone from the lobby with a click. To block more words, put
them one per line in `quizzes/blocked-words.txt` and restart.
