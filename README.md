# tigerquiz

A small self-hosted live quiz game in the style of Kahoot. One host screen on the
projector, players join from their phones with a PIN, fastest correct answer scores most.

## Run

```sh
npm install
npm start          # http://localhost:3000
```

- Host screen: `http://<your-ip>:3000/host.html`
- Players: `http://<your-ip>:3000/` and enter the PIN (or `/?pin=123456`)
- Reports: `http://<your-ip>:3000/reports.html`

Set `PORT` to change the port. Everyone must be able to reach the host machine on that
port (same Wi-Fi, or put it behind a reverse proxy).

```sh
npm test           # plays full games over websockets against a throwaway database
npm run check      # validate every quiz and class list before a lesson
```

## Writing quizzes

Drop a JSON file in `quizzes/`. The filename becomes the quiz id.

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
naming a file in `quizzes/images/` or an `http(s)` URL. The rest depends on `type`.

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

Put a roster in `quizzes/rosters/`:

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

## Reports

Every finished game is saved to `data/tigerquiz.db`, a SQLite file. Open
`/reports.html` for the list.

Each report shows the class average, the questions fewer than half the class got right,
a per-question breakdown with correct rate and average response time, and a per-player
table with scores and identifiers. "Download CSV" gives one row per player per question,
for grading or a spreadsheet.

Games the host abandons before the final standings are discarded rather than saved.
Set `TIGERQUIZ_DATA` to store the database somewhere else.

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
