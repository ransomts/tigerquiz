require "test_helper"
require "sqlite3"

# Importing the reports out of a Node tigerquiz database. The source database
# here is built with the schema from that version (main, lib/db.js) so the test
# is against the real shape and not this app's idea of it.
class ReportsImportTest < ActiveSupport::TestCase
  NODE_SCHEMA = <<~SQL
    CREATE TABLE games (
      id TEXT PRIMARY KEY, pin TEXT NOT NULL, quiz_id TEXT NOT NULL, title TEXT NOT NULL,
      roster_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      question_count INTEGER NOT NULL DEFAULT 0, player_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE questions (
      game_id TEXT NOT NULL, idx INTEGER NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL,
      answer TEXT, choices TEXT, explanation TEXT, source_idx INTEGER, correct_answer TEXT,
      PRIMARY KEY (game_id, idx));
    CREATE TABLE answers (
      game_id TEXT NOT NULL, idx INTEGER NOT NULL, player TEXT NOT NULL, response TEXT,
      ms INTEGER, correct INTEGER, points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, idx, player));
  SQL

  # The tally columns arrived later (main, 7649d92); a database from before that
  # has no such columns at all, not columns full of zeroes.
  PLAYERS_WITH_TALLIES = <<~SQL
    CREATE TABLE players (
      game_id TEXT NOT NULL, name TEXT NOT NULL, identifier TEXT, score INTEGER NOT NULL DEFAULT 0,
      rank INTEGER, correct INTEGER NOT NULL DEFAULT 0, scored INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, name));
  SQL
  PLAYERS_WITHOUT_TALLIES = <<~SQL
    CREATE TABLE players (
      game_id TEXT NOT NULL, name TEXT NOT NULL, identifier TEXT, score INTEGER NOT NULL DEFAULT 0,
      rank INTEGER, PRIMARY KEY (game_id, name));
  SQL

  STARTED = 1_788_948_000_000
  ENDED = 1_788_949_200_000

  setup do
    @user = User.create!(eppn: "ada@example.edu")
    @dir = Dir.mktmpdir
    @path = File.join(@dir, "tigerquiz.db")
  end

  teardown { FileUtils.remove_entry(@dir) }

  def build_source(tallies: true)
    db = SQLite3::Database.new(@path)
    db.execute_batch(NODE_SCHEMA)
    db.execute_batch(tallies ? PLAYERS_WITH_TALLIES : PLAYERS_WITHOUT_TALLIES)
    db.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?)",
               [ "g-1", "123456", "planets", "Planets", "p3", STARTED, ENDED, 2, 2 ])
    db.execute("INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?)",
               [ "g-1", 0, "choice", "Red planet?", "Mars", '["Venus","Mars"]', "Iron oxide", 3, "1" ])
    db.execute("INSERT INTO questions VALUES (?,?,?,?,?,?,?,?,?)",
               [ "g-1", 1, "poll", "Favourite?", nil, '["Mars","Venus"]', nil, 1, nil ])
    [ [ "ada", "1001", 1900, 1, 1, 1 ], [ "alan", nil, 0, 2, 0, 1 ] ].each do |name, ident, score, rank, correct, scored|
      values = [ "g-1", name, ident, score, rank ]
      values += [ correct, scored ] if tallies
      columns = "game_id, name, identifier, score, rank#{tallies ? ", correct, scored" : ""}"
      db.execute("INSERT INTO players (#{columns}) VALUES (#{(["?"] * values.length).join(",")})", values)
    end
    [ [ 0, "ada", "1", 900, 1, 1900 ], [ 0, "alan", "0", 1500, 0, 0 ],
      [ 1, "ada", "0", 700, nil, 0 ], [ 1, "alan", "1", 800, nil, 0 ] ].each do |idx, player, response, ms, correct, points|
      db.execute("INSERT INTO answers VALUES (?,?,?,?,?,?,?)", [ "g-1", idx, player, response, ms, correct, points ])
    end
    # a game the old process was still playing when it was restarted
    db.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?)",
               [ "g-2", "654321", "planets", "Abandoned", nil, STARTED, nil, 0, 0 ])
    db.close
  end

  test "a finished game comes across whole" do
    build_source
    quiz = @user.quizzes.create!(slug: "planets", title: "Planets", body: { "title" => "Planets", "questions" => [ { "text" => "Red planet?", "choices" => %w[Venus Mars], "answer" => 1 } ] })
    roster = @user.rosters.create!(slug: "p3", title: "Period 3", students: [ { "name" => "Ada Lovelace", "id" => "1001" } ])

    result = ReportsImport.new(@user, path: @path).run
    assert_equal 1, result.games
    assert_equal 1, result.unfinished, "the game that never finished is not a report"

    game = Game.find("g-1")
    assert_equal @user, game.user
    assert_equal "planets", game.quiz_slug
    assert_equal quiz, game.quiz, "linked to the quiz the slug names"
    assert_equal roster, game.roster
    assert_equal Time.zone.at(STARTED / 1000.0), game.started_at, "epoch milliseconds become a time"
    assert_equal Time.zone.at(ENDED / 1000.0), game.ended_at
    assert_equal 2, game.question_count

    q0, q1 = game.game_questions.order(:idx).to_a
    assert_equal "choice", q0.question_type
    assert_equal %w[Venus Mars], q0.choices, "JSON text becomes a real array"
    assert_equal 1, q0.correct_answer
    assert_equal 3, q0.source_idx
    assert_nil q1.correct_answer, "a poll has no right answer"

    ada = game.game_players.find_by(name: "ada")
    assert_equal [ "1001", 1900, 1, 1, 1 ], [ ada.identifier, ada.score, ada.rank, ada.correct, ada.scored ]

    answers = game.game_answers.order(:idx, :player).to_a
    assert_equal [ 1, 0, 0, 1 ], answers.map(&:response)
    assert_equal [ true, false, nil, nil ], answers.map(&:correct), "0/1/NULL become a boolean or nothing"
    assert_equal 1900, answers.first.points
  end

  test "the reports it builds are the ones the pages read" do
    build_source
    ReportsImport.new(@user, path: @path).run

    assert_equal [ "g-1" ], GameReport.listing(@user).map { |g| g["id"] }
    report = GameReport.new(Game.find("g-1")).to_h
    assert_equal "Red planet?", report["questions"][0]["text"]
    assert_equal 1.0, report["questions"][0]["correctRate"].to_f.round(2) * 2, "one of two got it right"
    assert_equal [ "ada", "alan" ], report["players"].map { |p| p["name"] }.sort
    assert_equal 1, GameReport.students(@user).find { |s| s["who"] == "1001" }["correct"]
  end

  test "importing twice adds nothing the second time" do
    build_source
    first = ReportsImport.new(@user, path: @path).run
    second = ReportsImport.new(@user, path: @path).run
    assert_equal 1, first.games
    assert_equal 0, second.games
    assert_equal 1, second.skipped
    assert_equal 1, Game.count
    assert_equal 4, GameAnswer.count
  end

  test "a database from before the counts moved onto the player row is filled in" do
    build_source(tallies: false)
    ReportsImport.new(@user, path: @path).run

    game = Game.find("g-1")
    assert_equal [ 1, 1 ], game.game_players.find_by(name: "ada").then { |p| [ p.correct, p.scored ] }
    assert_equal [ 0, 1 ], game.game_players.find_by(name: "alan").then { |p| [ p.correct, p.scored ] }
  end

  test "a quiz that was never imported still leaves a readable report" do
    build_source
    ReportsImport.new(@user, path: @path).run
    game = Game.find("g-1")
    assert_nil game.quiz, "nothing to link to"
    assert_equal "planets", game.quiz_slug, "but the report still says which quiz it was"
  end

  test "a missing database is refused" do
    assert_raises(ArgumentError) { ReportsImport.new(@user, path: File.join(@dir, "nope.db")).run }
  end
end
