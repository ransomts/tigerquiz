# Porting tigerquiz to Ruby on Rails

This branch carries the Rails port. The Node application stays on `main` and is
the reference implementation until the port is complete; compare with
`git show main:server.js` and friends rather than keeping two trees here.

## Goals

- Same game, same quiz format, same reports. Existing `quizzes/*.json` files import unchanged.
- Sign-in through the department's Shibboleth, terminated in Apache, with per-instructor
  ownership of quizzes, class lists and reports.
- No infrastructure beyond Ruby, SQLite and Apache. No Redis, no separate job runner.

## Stack

| Choice | Reason |
| --- | --- |
| Rails 8.x, Ruby 3.2+ | Ruby 3.2.3 is what the machines have. Rails 8 treats SQLite as production-ready and ships Solid Cable/Queue if ever needed |
| SQLite in WAL mode | Same as today. One file, backed up with `cp` |
| Puma, single mode, one process, ~8 threads | Game state lives in memory, so there must be exactly one process. Bind to a Unix socket that Apache proxies to |
| Action Cable with the `async` adapter | In-process pub/sub is all a single process needs. Switching to Solid Cable later is a one-line config change |
| Plain ERB views, no asset pipeline gymnastics | The current HTML/CSS/JS moves over nearly verbatim. Vendor `actioncable.js` under `public/` |
| Minitest | Rails default, no extra tooling |

The single-process constraint is deliberate. A department runs a handful of games at
once with a few hundred phones at most, and the in-process design keeps question
timers millisecond-accurate and the replay/rewind logic simple. If it ever needs to
scale past one box, the `GameRegistry` is the only thing to replace.

## Layout

```
app/
  controllers/
    application_controller.rb   # Shibboleth current_user, ownership helpers
    play_controller.rb          # / (join page), POST /join, POST /lobby
    host_controller.rb          # /host, POST /host/games, POST /host/resume
    quizzes_controller.rb       # editor pages and JSON API
    rosters_controller.rb
    reports_controller.rb       # list, show, csv, delete, review-quiz
    qr_controller.rb            # /qr.svg
  channels/
    game_channel.rb             # the one websocket channel
  models/
    user.rb quiz.rb roster.rb game.rb game_question.rb game_player.rb game_answer.rb
lib/
  tigerquiz/
    questions.rb                # port of lib/questions.js, pure functions
    nicknames.rb                # port of lib/nicknames.js
    room.rb                     # port of the Room class in server.js
    registry.rb                 # pin -> Room, the mutex, the timer thread
    quiz_check.rb               # port of tools/check-quizzes.mjs
  tasks/
    quizzes.rake                # quizzes:import, quizzes:check
config/
  deploy/apache.conf.example    # mod_proxy, mod_proxy_wstunnel, mod_shib
  deploy/tigerquiz.service      # systemd unit
```

## Data model

| Table | Notes |
| --- | --- |
| `users` | `eppn` (from Shibboleth, unique), `display_name`, `role` (`instructor`/`admin`) |
| `quizzes` | `user_id`, `slug`, `title`, `body` (JSON: the whole quiz document as the editor already produces it) |
| `rosters` | `user_id`, `slug`, `title`, `students` (JSON) |
| `games` | as today plus `user_id`; `pin`, `quiz_id`, `title`, `roster_id`, `started_at`, `ended_at`, `question_count`, `player_count`, `solo` |
| `game_questions` | as today's `questions` table, keyed `(game_id, idx)` |
| `game_players` | as today's `players` table |
| `game_answers` | as today's `answers` table |

Keeping the quiz document as one JSON column, rather than normalising questions into
rows, means the editor, validator and grader all keep working on exactly the shape they
already know. It also keeps import and export trivial. Question images move to
Active Storage on local disk, attached to the quiz.

Quiz and roster slugs are unique per user, so two instructors can both have `week-3`.

## Authentication

Apache does all the Shibboleth work. Rails only trusts a header:

```ruby
# application_controller.rb
before_action :authenticate

def current_user
  @current_user ||= begin
    eppn = request.headers["X-Remote-User"].presence
    eppn ||= ENV["TIGERQUIZ_DEV_USER"] if Rails.env.development? || Rails.env.test?
    User.find_or_create_by!(eppn: eppn) if eppn
  end
end
```

Apache sets that header from the Shibboleth session and strips any incoming copy of it,
so it cannot be spoofed from outside. Puma listens only on a Unix socket, so nothing
reaches it except through Apache.

Which paths need a session is decided in Apache, not Rails:

| Path | Shibboleth |
| --- | --- |
| `/`, `/join`, `/lobby`, `/qr.svg`, `/cable`, `/nickname` | none, students join by PIN |
| `/host`, `/edit`, `/reports`, `/api/...` | required |

Rails still refuses instructor actions without a user, as a second line of defence.

Open question, to settle before phase 3: whether students should also sign in. If they
do, the roster and nickname machinery becomes optional because identity comes from the
header. Phase 1 keeps PIN-and-nickname joining so the app works exactly as now.

## The realtime layer

socket.io gives three things Action Cable does not: reply callbacks, per-socket
targeting by id, and rooms. Each has a straightforward substitute.

**Replies.** The five events that wait for an answer become HTTP requests, which is
where a request/response belongs anyway:

| socket.io event | Becomes |
| --- | --- |
| `host:create` | `POST /host/games` returns `{pin, token}` |
| `host:resume-session` | `POST /host/resume` |
| `player:join` | `POST /join` returns `{ok, name}` or `{error}` |
| `player:lobby` | `POST /lobby` |
| `player:answer` | stays on the channel; the ack is a `transmit` back to that one subscriber |

**Targeting.** Every subscription streams from `game:PIN:host` or `game:PIN:players`,
plus `game:PIN:player:NAME` for the per-player result and end-of-game messages that today
go to a socket id. `transmit` covers "reply to just this socket".

**Rooms and lifecycle.** `GameChannel#subscribed` takes `{pin, role, name, token}`,
validates against the registry, marks the player connected, and replays the current
screen to a reconnecting host or player. `unsubscribed` marks the player disconnected or
starts the host grace timer, exactly like today's `disconnect` handler.

Host controls (`start`, `next`, `prev`, `goto`, `pause`, `skip`, `revote`, `replay`,
`kick`) become channel actions called with `perform`.

**Timers.** `Registry` owns one background thread that wakes for the earliest pending
deadline. `Room#arm_timer` and the host grace period schedule on it. Every entry point
into a `Room` (channel action, HTTP request, timer firing) takes the registry mutex, so
a room is never touched by two threads at once. This replaces `setTimeout` without
introducing a job queue whose polling interval would put the question clock a second late.

**Client.** `host.html` and `index.html` swap `io()` for `createConsumer()` and each
`socket.on("game:x")` for a `received` switch on a `type` field. The rest of the DOM code
is untouched.

## Porting the pure logic

`questions.js` and `nicknames.js` are pure functions and port line for line. The parts
that need care because JavaScript and Ruby differ:

- `normText` uses NFKD normalisation and strips combining marks. Ruby:
  `s.unicode_normalize(:nfkd).gsub(/\p{Mn}/, "")`, then the same `\p{L}\p{N}` filter.
- `levenshtein` and `fuzzTolerance` are plain loops.
- `Math.random` shuffles become `Array#shuffle(random:)` so tests can seed them.
- `Number` coercion in `normalizeQuestion` needs explicit `Integer()`/`Float()` with rescue.

To prove the port is faithful, phase 1 generates a fixture file from the Node code:
a few hundred `(question, response) -> grade` cases and `normText` inputs, dumped as JSON
with a small script run once on `main`. The Ruby tests replay them. Any divergence in
scoring shows up before a game does.

## Phases

Each phase leaves the branch runnable and tested.

1. **Skeleton and pure logic.** `rails new` at the repo root, `Tigerquiz::Questions`,
   `Tigerquiz::Nicknames`, `Tigerquiz::QuizCheck`, parity fixtures and tests,
   `rails quizzes:check`. Delete `server.js`, `lib/`, `node_modules` from this branch.
2. **Models and import.** Migrations, models, `rails quizzes:import` reading
   `quizzes/*.json` and `quizzes/rosters/*.json` into the first user, images into
   Active Storage.
3. **Authentication and ownership.** Header auth, dev fallback, scoping every query by
   `current_user`, Apache config example.
4. **Editor and reports.** Move `edit.html`, `edit.js`, `reports.html` into views,
   controllers for the JSON API they call, CSV export, review-quiz generation,
   `/qr.svg`. Everything except playing a game works at the end of this phase.
5. **Game engine.** `Room`, `Registry`, `GameChannel`, join/create/resume endpoints,
   rewire `host.html` and `index.html`. Port `test/game.test.mjs` as a test that drives
   `Room` directly through a whole game, plus channel tests for connect, answer, and
   disconnect handling.
6. **Deployment.** Puma config, systemd unit, Apache snippet, backup note, README rewrite.

Rough effort for one person who knows Rails, working part time:

| Phase | Effort |
| --- | --- |
| 1 | 2 days |
| 2 | 1 day |
| 3 | 1 day |
| 4 | 2 days |
| 5 | 5 to 8 days |
| 6 | 1 day |

## Performance

Ruby is slower than Node at raw computation, and it does not matter here. The CPU work
in a game is grading a few hundred answers per question, microseconds each. Everything
else is waiting on the network or SQLite.

What does deserve attention:

- **One process.** Puma must run in single mode. Cluster mode would give each worker
  its own copy of the registry and games would vanish between requests.
- **The GVL.** Only one thread runs Ruby at a time per process, but threads waiting on
  I/O release it. With ~8 threads and Action Cable's own event loop, a few hundred
  websocket connections are comfortable. A `Room` action holding the mutex should do no
  I/O beyond its SQLite writes, which are sub-millisecond in WAL mode.
- **Broadcast fan-out.** Sending results to 200 phones is a loop over 200 connections in
  the async adapter, a few milliseconds total.
- **Timer accuracy.** The in-process timer thread fires within a millisecond or two.
  Using a job queue instead would add its polling interval, which is why the plan avoids one.
- **Memory.** Expect 150 to 250 MB resident for the Rails process against about 60 MB
  for Node. Irrelevant on a server, worth knowing on a small VM.
- **Boot time.** Several seconds instead of under one. Matters only for restarts.

Where Ruby would start to matter is thousands of simultaneous games, which is not this
application.
