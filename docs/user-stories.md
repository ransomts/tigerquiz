# User stories

What tigerquiz is for, written as the things people need to be able to do.
Each story has acceptance criteria concrete enough to check against the app,
and a status: **done** means it is in the code and covered by a test or the
teaching walkthrough; **open** means it is wanted and not built.

This is the document to read before adding a feature. If a change does not
serve one of these stories, or a new one worth writing down, it probably does
not belong. The stories are grouped by who is asking:

- **Host**: the person at the front of the room running a live game.
- **Student**: anyone answering on a phone, live or at home.
- **Author**: an instructor writing or importing quizzes and class lists.
- **Reviewer**: an instructor reading what happened afterwards.
- **Operator**: whoever installs and runs the server.

The identifiers (H1, S4 and so on) are stable; refer to them in commit messages
and tests rather than renumbering.

## Host

### H1. Start a game in under a minute — done
As a host, I want to pick a quiz and put a PIN on the projector, so that a class
can be playing before anyone loses interest.
- The setup screen lists every valid quiz with its question count, and
  disables any file that would fail mid-lesson with the reason beside it.
- Creating a game shows a six-digit PIN, the join address and a QR code
  encoding the join link with the PIN filled in.
- Players appear in the lobby as they join, and Start is enabled as soon as
  there is one.
- If the host opened the page as `localhost`, the lobby warns that students
  cannot reach that address, before the lesson rather than during it.

### H2. Control the pace — done
As a host, I want to pause, end a question early, go back and jump around, so
that the game follows the discussion rather than the other way round.
- Space or Enter advances; the arrow keys move between questions; `P` pauses.
- Pause stops the clock for everyone, refuses answers, and does not count the
  paused time against anyone's speed.
- Back replays the previous question. Replaying rewinds every score and
  streak to what they were before that question, so nobody is paid twice.
- Jump to opens any question directly; skipped questions stay unanswered.
- "End question now" closes a question the class is clearly done with.

### H3. Survive a dropped laptop — done
As a host, I want a closed lid or a wifi blip not to end the lesson, so that I
can trust the tool in a room I do not control.
- If the host's browser disconnects, the game pauses and is held open for
  three minutes (`HOST_GRACE_MS`), and players are told the host is away.
- Reopening the host page rejoins the same game automatically and puts the
  screen back on whichever question or result it was showing.

### H4. Teach from the results, not just show them — done
As a host, I want each results screen to tell me what the class believes, so
that I can address the misconception rather than move on.
- Results show the distribution of answers with the correct one marked, and
  the explanation from the quiz file underneath.
- When a vote is split (roughly a third to four fifths correct), the screen
  offers "Discuss and re-vote". The second vote is charted beside the first,
  with the before-and-after correct count.
- A quiz can mark a question as worth discussing so the offer is always made.

### H5. Run a lecture poll, not a game — done
As a host, I want to ask questions without points or a leaderboard, so that a
lecture can be polled without turning it into a competition.
- "Lecture mode" is a checkbox on the setup screen and applies to the whole game.
- Answers are still graded, charted and saved to the report.
- Nobody earns points, no leaderboard appears between questions, and the end
  screen is a thank-you rather than a podium. Phones show Correct or Wrong and
  the explanation, nothing about rank.
- The report says points were off.

### H6. Ask a question I did not plan — done
As a host, I want to fire off a question on the spot, so that a moment in the
discussion can be checked without having authored anything.
- "Quick question" opens a game with no quiz file.
- A composer offers lettered multiple choice, true or false, typed answer,
  typed number, word cloud or written answer, with a time limit. Leaving the
  correct answer blank makes it a poll.
- Each question is asked as soon as it is composed; results are shown as usual;
  the host asks another or presses Finish.
- The report records every question asked.

### H7. Let latecomers in — done
As a host, I want somebody arriving ten minutes late to join anyway, so that
participation is not lost to a late bus.
- A player entering the PIN after the start joins on zero and plays from the
  next question. The join screen tells them the game is under way.
- A player the host has removed cannot come back in under that name or
  identity.
- Rewinding past a latecomer's first question zeroes them, so a replay cannot
  pay them twice.

### H8. Keep the room civil — done
As a host, I want rude nicknames kept out and the power to remove anyone, so
that a projector in front of thirty people is safe to leave on.
- Nicknames are screened against a word list, with disguises such as `sh1t`
  collapsed first and ordinary words such as `Scunthorpe` allowed through.
- The dice button suggests a nickname so nobody has to invent one.
- Clicking a name in the lobby removes that player, and a removed player's
  late answer does not count.

### H9. Rehearse before the class sees it — done
As a host, I want to play the quiz alone, so that I read every question on the
projector before a class does.
- "Rehearse this quiz alone" runs the whole quiz with no players.
- Rehearsals produce no report.

### H10. Finish with a flourish — done
As a host, I want a podium and a "play again", so that the end of the game is
a moment and not a screen.
- The game ends by revealing third, second, then first, with sound, then the
  full standings. Players tied on score share a rank.
- "Play again, same players" restarts the quiz with everyone still in the room
  and scores at zero, recorded as a separate game.

### H11. Set homework — done
As a host, I want to leave a quiz open for students to do in their own time,
so that the same questions and the same report serve outside the lesson.
- "Set as homework" leaves a quiz open under a six-digit code, with an
  optional closing time, and shows the code with a QR for the projector.
- Open homework is listed on the setup screen with how many have started and
  finished, a link to its report, and a Close button.
- The quiz is copied when the homework is made, so later edits to the file do
  not change questions already being answered.
- Lecture mode applies to homework too.

### H12. Run it in teams — done
As a host, I want players grouped into teams with a team score, so that a
class can be split by table rather than ranked one against another.
- A teams dropdown on the setup screen, two to six. Players are shared out
  across the teams as they join, and the lobby chips wear the team colour.
- The leaderboard and the podium rank teams by the average score of their
  members, with the members listed under each team.
- Each phone shows its own team on the waiting screen and its team's score and
  rank after each question.
- The report records each player's team.

## Student

### S1. Join from a phone with nothing to install — done
As a student, I want to enter a PIN and a name in a browser, so that joining
takes seconds and leaves nothing on my phone.
- The join page is public: no account, no app, no password.
- Typing a full PIN looks the game up and shows its title, and whether it
  asks for a name or ID, before Join is pressed.
- A game that has started, or a homework code, says so on the join page.

### S2. Answer every kind of question with a thumb — done
As a student, I want each question type to work on a small touchscreen, so
that answering is never the hard part.
- Choices are large coloured buttons with symbols, so they are tellable apart
  without reading and without colour.
- Typed answers, numbers, blanks, sliders, ordering, matching, tapping a
  picture and written answers each have a control that fits a phone, with a
  Submit button that stays disabled until the answer is complete.
- Fill-in-the-blank shows the sentence with the inputs sitting in the gaps.
- The question and its choices are mirrored to the phone unless the quiz
  turns that off, so a student who cannot read the projector still has
  everything they need. The answer itself never reaches the phone.

### S3. Know how I did, straight away — done
As a student, I want to see whether I was right and why, so that a wrong
answer teaches me something.
- After each question the phone shows Correct, Close or Wrong, what I
  answered, what the answer was if I was wrong, and the explanation.
- When points are on it also shows points gained, streak, rank, movement, and
  the gap to the person just ahead, or who I am level with.
- Not answering is reported as "No answer" when the host ended the question,
  and "Time's up" when the clock did, so nobody is blamed for a host moving on.

### S4. Not lose my place — done
As a student, I want a dropped connection or a refreshed page not to cost me
the game, so that a bad signal is an annoyance and not a disqualification.
- A refreshed or reconnected phone rejoins under the same nickname with its
  score intact, and lands on whichever screen the game is on.
- If I had already answered the open question, I see the waiting screen, not
  the question again.

### S5. Do homework at my own pace — done
As a student, I want to work through an assigned quiz whenever I like, one
question at a time, so that revision fits around the rest of my day.
- Entering a homework code gives one question at a time, with the answer and
  explanation after each and a Next button.
- No clock is enforced, though answering faster still earns more when points
  are on.
- Coming back later, from any device, picks up at the next unanswered question.
  I am recognised by my class-list entry or identifier.
- The end screen shows my score and, when points are on, my rank among those
  who have finished so far.

### S6. Answer anonymously — done
As a student, I want some polls to be anonymous, so that I will answer a
sensitive question honestly.
- A question can be marked anonymous in the editor; the phone says so above
  the answer controls.
- Every answer is still counted and charted, but the report stores them
  shuffled and unnamed, so neither the per-player table nor the CSV can tie
  one to a person.
- Only polls, word clouds, written answers and files can be anonymous, since
  a scored answer has to belong to somebody.

## Author

### A1. Write a quiz without touching JSON — done
As an author, I want to build a quiz in a form, so that I never have to learn
the file format.
- The editor offers every question type as a card with a one-line description
  and an example, not a dropdown of names.
- Each type has its own fields: choices with the correct one ticked, accepted
  spellings, slider range and tolerance, items in order, pairs, a picture with
  a box dragged over the target, and so on.
- The quiz saves itself a moment after every change and says so in one line.
  A half-finished quiz is reported as "things to fix", not as an error.
- Delete, change type and reorder can be undone.
- Preview shows a question the way a phone will show it.

### A2. Bring questions I already have — done
As an author, I want to paste a list of questions or a spreadsheet, so that an
existing bank becomes a quiz in one step.
- Pasted text with one option per line and `*` on the correct one becomes
  multiple choice, true or false, or multiple-answer questions.
- A CSV with question, choices, answer number, time and explanation columns
  imports the same way.
- "Duplicate" copies a whole quiz; "Duplicate" on a question copies one.

### A3. Catch mistakes before the lesson — done
As an author, I want a checker that reads every quiz and class list, so that a
wrong answer index fails on my laptop and not in front of a class.
- `npm run check` reports errors (a bad answer index, a missing image, blanks
  without answers) and warnings (no explanation, a very short timer, a choice
  too long to fit).
- The editor runs the same checks as I type.

### A4. Keep a class list — done
As an author, I want a list of names and IDs, so that a game can insist on
real identities and tell me who was absent.
- A class list is typed as one student per line, with an optional ID after a
  comma, or dropped into the rosters folder by hand.
- When a game uses one, players must identify themselves as somebody on it, by
  name or ID, with case, spacing and punctuation ignored.
- The report names anyone on the list who never played.

### A5. Own my work on a shared server — done
As an author on a campus install, I want my quizzes, class lists and reports
to be mine, so that colleagues cannot overwrite them and I cannot see theirs.
- With sign-in on, saving something new makes it mine. Unowned files that
  ship with the app or were dropped in by hand are visible to everyone and
  editable by nobody until claimed.
- Another instructor's quiz is reported as missing, not forbidden, so a
  listing cannot be used to enumerate other people's work.
- An unowned report is shared with nobody, since it holds students' names and
  answers.

### A6. Import from other tools' spreadsheets — done
As an author, I want to import the Excel template that Kahoot and similar tools
export, so that moving a question bank over is a drop, not a retype.
- The import dialog takes a `.xlsx` or `.csv` file. Kahoot's template, a
  Wayground export, and our own column layout are recognised by their header
  row; the sheet is read in the browser with nothing uploaded.
- Multiple choice, multiple answer, true or false and polls come through with
  their time limits and explanations. A file with no recognisable header says
  so rather than inventing questions.

### A7. Put video or audio in a question — done
As an author, I want to embed a short clip in a question, so that listening and
watching questions are possible, not only reading ones.
- A question or slide takes a YouTube link, a direct video or audio URL, or a
  file in the media folder. The editor says what it understood.
- The clip plays on the host screen when the question opens, with a start
  time if one was given, and stops when the results come up.
- Phones are told to watch or listen on the host screen rather than playing
  thirty copies; the clip's address never reaches them.
- The checker reports a media file that is missing.

### A8. Weight a question — done
As an author, I want to mark one question as double points or no points, so
that the scoring reflects what matters.
- A "Worth" selector on every scored question: normal, double, half, or no
  points while still graded.
- The multiplier applies to what a right or partly right answer earns, live
  and in homework; streak bonuses are unchanged.
- The host screen shows a badge and the phone a note, so nobody is surprised.
- The report keeps the weight, so marking by hand pays the right amount.

## Reviewer

### R1. See how a lesson went — done
As a reviewer, I want a report of every game, so that I know what landed and
what did not.
- Every finished game is listed; abandoned games are discarded.
- A report shows the class average, the questions fewer than half got right,
  each question's correct rate and average response time, and every player's
  score and identifier.
- Each question is broken down by what people actually chose, with the most
  common wrong answer named, so the misconception is visible and not just the
  difficulty.
- "Download CSV" gives one row per player per question.

### R2. Follow a student across the term — done
As a reviewer, I want one view of a student over every game, so that I can
tell whether someone is struggling before the exam does.
- The Students tab lists everyone who has played, keyed on identifier or
  class-list name rather than the nickname they picked that day, with games
  played, correct rate and last played.
- Clicking a student lists their games with score, rank and correct count.

### R3. Export a gradebook — done
As a reviewer, I want a spreadsheet with one row per student and one column
per game, so that marks go into the gradebook in one paste.
- Two downloads: percent correct, or points.
- A game a student did not play is left blank, not zero, so absence is not
  mistaken for a score of nothing.
- Homework and lecture-mode games are included like any other.

### R4. Turn a bad result into the next lesson — done
As a reviewer, I want a review quiz built from what the class missed, so that
the next lesson can open with retrieval of exactly those questions.
- "Make a review quiz" writes a new quiz with the questions a class did worst
  on, worst first, explanations kept, and it appears in the host list.
- Questions are matched back to the original file by recorded position, so
  shuffling does not confuse it.

### R5. Send grades to the LMS — open
As a reviewer, I want scores pushed to Canvas, so that nothing has to be pasted
by hand. This is the largest remaining gap against Top Hat and iClicker.

### R6. Grade written answers — done
As a reviewer, I want to mark written answers right, partial or wrong after the
fact, so that a written question can count towards a score.
- The report lists every written answer and handed-in file with Right,
  Partial and Wrong buttons, and the model answer beside them.
- A mark earns full or half the points a right answer would, scaled by the
  question's weight; wrong earns nothing. Scores, ranks, correct rates and the
  gradebook follow at once. Clicking the current mark takes it back.
- In lecture mode a mark changes the correct count and nothing else.

### R7. Collect files — done
As a reviewer, I want a question that takes a photo or PDF upload, so that
worked solutions can be handed in through the same tool.
- A "hand in a file" question type. The phone offers the camera or a file
  picker, uploads the file, and submits once it is there.
- Photos and PDFs up to 10 MB; anything else is refused with a reason.
- A player can only answer with their own upload; the host results show
  thumbnails; the report links each file and offers it for marking.
- Files live beside the database, are covered by the backup job, and go when
  the report is deleted.

## Operator

### O1. Run it with nothing but Node — done
As an operator, I want to clone, install and start, so that a classroom laptop
is a server in two commands.
- `npm install` and `npm start` are the whole setup. SQLite is a Node built-in,
  so nothing is compiled and no database is installed.
- A Dockerfile and compose example do the same in a container.
- `PORT` and `HOST` are the only settings most installs need.

### O2. Put it behind the campus proxy — done
As an operator, I want to serve it under a sub-path with the teacher pages
behind a password or Shibboleth, so that students can reach the join page and
nobody else can reach anything else.
- Every page and asset works under a sub-path such as `/quiz/`.
- Protecting the whole of `/api/` and carving the nickname and identity
  endpoints back out covers every teacher endpoint, including ones added later.
- With Shibboleth, Apache passes one identity header and the app reads nothing
  else; a dev-only override exists and is ignored in production.

### O3. Not be knocked over by a class guessing PINs — done
As an operator, I want PIN guessing throttled, so that one bored student cannot
sweep the space or exhaust the server.
- Wrong guesses cost a token from a per-client budget; right ones do not.
- Behind a proxy the client address can be taken from the forwarded header,
  but only when explicitly switched on.

### O4. Restart without losing reports — done
As an operator, I want a restart or a crash to be visible and tidy, so that an
upgrade is not a mystery to the people playing.
- Live games are told the server is going away rather than left hanging.
- Finished games and open homework survive a restart; half-played live rooms
  are swept.
- The database is checkpointed on the way out, and a backup job can read it
  while the server writes.

### O5. Trust the upgrades — done
As an operator, I want every push checked, so that weekly dependency bumps can
be merged on a glance.
- Lint, typecheck, unit tests and full websocket games run in CI on every push.
- The code stays plain JavaScript with TypeScript as a checker only, so the
  deploy path has no build step.

## How to use this document

- A new feature starts as a story here, with criteria that can be checked
  against the app. Write the story before the code.
- When a story moves from open to done, the pull request should point at the
  tests that cover its criteria.
- `docs/teaching-with-tigerquiz.md` is the narrative version of the Host and
  Student stories for one lesson; keep the two in step.
