# Load the game reports out of a Node tigerquiz database, so three years of
# lessons survive the move to this version. Quizzes and class lists come across
# as files through QuizImport; this is the half that only ever lived in SQLite.
#
# The Node schema is close enough to copy row for row. What has to change:
# timestamps were epoch milliseconds, JSON columns were text, `correct` was 0/1,
# and games now belong to a user and point at the quiz and class list records.
class ReportsImport
  Result = Struct.new(:games, :players, :answers, :skipped, :unfinished, keyword_init: true)

  # Node kept the quiz and roster slugs on the game; this version keeps those
  # too, and links the records as well when the user already has them.
  def initialize(user, path:, out: nil)
    @user = user
    @path = Pathname.new(path)
    @out = out
  end

  def run
    raise ArgumentError, "No database at #{@path}" unless @path.file?

    result = Result.new(games: 0, players: 0, answers: 0, skipped: 0, unfinished: 0)
    each_source_game do |db, g|
      # A game that never finished belonged to a room in the old process's
      # memory. It can never finish or be resumed, and it is not in the reports.
      next result.unfinished += 1 if g["ended_at"].nil?
      next result.skipped += 1 if Game.exists?(id: g["id"])

      import_game(db, g, result)
    end
    say "Imported #{result.games} games, #{result.players} players and #{result.answers} answers for #{@user.eppn}" \
        "#{result.skipped > 0 ? ", skipped #{result.skipped} already imported" : ""}" \
        "#{result.unfinished > 0 ? ", ignored #{result.unfinished} that never finished" : ""}"
    result
  end

  private

  def each_source_game
    require "sqlite3"
    db = SQLite3::Database.new(@path.to_s, readonly: true, results_as_hash: true)
    db.execute("SELECT * FROM games ORDER BY started_at").each { |g| yield db, g }
  ensure
    db&.close
  end

  def import_game(db, g, result)
    Game.transaction do
      game = @user.games.create!(
        id: g["id"], pin: g["pin"], quiz_slug: g["quiz_id"], title: g["title"],
        quiz: @user.quizzes.find_by(slug: g["quiz_id"]),
        roster: g["roster_id"] && @user.rosters.find_by(slug: g["roster_id"]),
        started_at: at(g["started_at"]), ended_at: at(g["ended_at"]),
        question_count: g["question_count"] || 0, player_count: g["player_count"] || 0
      )
      rows(db, "questions", g["id"]).each do |q|
        game.game_questions.create!(
          idx: q["idx"], question_type: q["type"], text: q["text"], answer: q["answer"],
          choices: json(q["choices"]), explanation: q["explanation"],
          source_idx: q["source_idx"], correct_answer: json(q["correct_answer"])
        )
      end
      players = rows(db, "players", g["id"])
      players.each do |p|
        game.game_players.create!(
          name: p["name"], identifier: p["identifier"], score: p["score"] || 0, rank: p["rank"],
          # older Node databases predate these columns, and are filled in below
          # from the answers, which is where the truth was all along
          correct: p["correct"] || 0, scored: p["scored"] || 0
        )
      end
      answers = rows(db, "answers", g["id"])
      answers.each do |a|
        game.game_answers.create!(
          idx: a["idx"], player: a["player"], response: json(a["response"]),
          ms: a["ms"], correct: bool(a["correct"]), points: a["points"] || 0
        )
      end
      backfill_tallies(game) if players.any? { |p| p["scored"].nil? }

      result.games += 1
      result.players += players.length
      result.answers += answers.length
    end
    say "  #{g["title"]} (#{Time.zone.at(g["started_at"] / 1000).to_date}, #{g["player_count"]} players)"
  rescue ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique => e
    result.skipped += 1
    say "  skipped #{g["id"]}: #{e.message.lines.first.strip}"
  end

  def rows(db, table, game_id)
    db.execute("SELECT * FROM #{table} WHERE game_id = ?", [ game_id ])
  end

  # A database written before the counts lived on the player row: work them out
  # from the answers, which is what that version did on every page load anyway.
  def backfill_tallies(game)
    tallies = game.answer_tallies
    game.game_players.each do |p|
      correct, scored = tallies[p.name] || [ 0, 0 ]
      p.update_columns(correct: correct, scored: scored)
    end
  end

  def at(ms) = ms && Time.zone.at(ms / 1000.0)
  def bool(v) = v.nil? ? nil : v == 1
  def json(text) = text.nil? ? nil : JSON.parse(text)
  def say(msg) = @out&.puts(msg)
end
