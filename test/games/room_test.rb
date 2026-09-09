require "test_helper"

# Whole games played through a Room with a recording bus, following the suites
# in test/game.test.mjs from the Node version. The channel and HTTP layers are
# thin; this is where the rules of the game are checked.
class RoomTest < ActiveSupport::TestCase
  TRUE_ORDER = [ "Moon landing", "Fall of the Berlin Wall", "First iPhone", "COVID-19 pandemic" ].freeze

  setup do
    Games::Registry.reset!
    @user = User.create!(eppn: "ada@example.edu")
    QuizImport.new(@user, dir: Rails.root.join("quizzes")).run
    @bus = Games::RecordingBus.new
  end

  teardown { Games::Registry.reset! }

  # ---------- helpers ----------

  def room_for(slug, roster: nil, seed: 1, **opts)
    quiz = Tigerquiz::QuizDocument.prepare(@user.quizzes.find_by!(slug: slug).playable, random: Random.new(seed))
    room = Games::Registry.create(quiz: quiz, roster: roster && @user.rosters.find_by!(slug: roster).playable, user: @user, bus: @bus, **opts)
    room.host_connected("host-1")
    room
  end

  def join(room, name, identifier = nil)
    res = room.join(name, identifier)
    assert res["ok"], "#{name} could not join: #{res["error"]}"
    room.player_connected(name, "conn-#{name}")
    res
  end

  def answer!(room, name, response)
    r = room.record_answer(name, response)
    assert r["ok"], "#{name} rejected: #{r["error"]}"
  end

  def host_question(room) = @bus.on(room.host_stream, "game:question").last
  def host_results(room) = @bus.on(room.host_stream, "game:results")
  def player_results(room, name) = @bus.on(room.player_stream(name), "game:results")
  def game_end(room) = @bus.on(room.host_stream, "game:end").last

  def right_order(q) = TRUE_ORDER.map { |label| q["items"].index(label) }

  # ---------- suites ----------

  test "every question type, scoring and the report" do
    room = room_for("all-types")
    assert_equal "Student ID", room.describe["identifier"]
    assert_equal "Student ID", room.lobby_info["identifier"]
    assert_equal "Enter your Student ID", room.join("sneak", "")["error"]

    %w[ada alan grace].zip(%w[1001 1002 1003]).each { |n, id| join(room, n, id) }

    # ada answers everything correctly, alan partially, grace wrongly
    plan = {
      "choice" => { "ada" => ->(q) { q["choices"].index("Mars") }, "alan" => ->(q) { q["choices"].index("Mars") }, "grace" => ->(q) { q["choices"].index("Venus") } },
      "truefalse" => { "ada" => ->(_) { 0 }, "alan" => ->(_) { 0 }, "grace" => ->(_) { 1 } },
      "multi" => { "ada" => ->(q) { [ q["choices"].index("11"), q["choices"].index("17") ] }, "alan" => ->(q) { [ q["choices"].index("11") ] }, "grace" => ->(q) { [ q["choices"].index("9") ] } },
      "slider" => { "ada" => ->(_) { 206 }, "alan" => ->(_) { 215 }, "grace" => ->(_) { 120 } },
      "text" => { "ada" => ->(_) { "Au" }, "alan" => ->(_) { "  au. " }, "grace" => ->(_) { "Ag" } },
      "order" => { "ada" => ->(q) { right_order(q) }, "alan" => ->(q) { right_order(q) }, "grace" => ->(q) { right_order(q).reverse } },
      "poll" => { "ada" => ->(_) { 1 }, "alan" => ->(_) { 1 }, "grace" => ->(_) { 3 } },
      "wordcloud" => { "ada" => ->(_) { %w[mitosis cells] }, "alan" => ->(_) { [ "Mitosis" ] }, "grace" => ->(_) { [ "cells" ] } }
    }

    seen = []
    room.start
    9.times do
      q = host_question(room)
      seen << q["type"]
      if q["type"] == "slide"
        room.advance
        next
      end
      %w[ada alan grace].each { |n| answer!(room, n, plan[q["type"]][n].call(q)) }
      assert_equal "results", room.state, "the last answer ends the question at once"
      room.advance
    end
    the_end = game_end(room)
    assert the_end, "the game reached the end"

    assert_equal "slide,choice,truefalse,multi,slider,text,order,poll,wordcloud", seen.join(",")
    results = host_results(room)
    refute results.any? { |r| r["type"] == "slide" }, "a slide has no results step"
    by_type = ->(t) { results.find { |r| r["type"] == t } }
    assert_equal "counts", by_type.call("choice")["summary"]["kind"]
    assert_equal 4, by_type.call("multi")["summary"]["counts"].sum, "multi counts every selection"
    assert_equal 3, by_type.call("slider")["summary"]["values"].length
    assert_equal 206, by_type.call("slider")["answer"]["value"]
    assert_equal 4, by_type.call("order")["summary"]["perSlot"].length
    assert_nil by_type.call("poll")["answer"]
    assert by_type.call("wordcloud")["summary"]["words"].any? { |w| w["n"] == 2 }, "word cloud merges case variants"

    answerable = seen - [ "slide" ]
    r = ->(name, type) { player_results(room, name)[answerable.index(type)] }
    assert_equal true, r.call("ada", "text")["correct"]
    assert_equal true, r.call("alan", "text")["correct"], "case and punctuation are forgiven"
    assert_equal false, r.call("grace", "text")["correct"]
    assert_equal true, r.call("ada", "multi")["correct"]
    assert_equal 0.5, r.call("alan", "multi")["ratio"]
    assert_equal 0, r.call("grace", "multi")["ratio"]
    assert_equal true, r.call("ada", "slider")["correct"]
    assert r.call("alan", "slider")["ratio"] > 0 && r.call("alan", "slider")["correct"] == false, "a near slider guess earns partial credit"
    assert_equal 0, r.call("grace", "slider")["ratio"]
    assert_equal true, r.call("ada", "order")["correct"]
    assert_equal 0, r.call("grace", "order")["ratio"]
    assert_equal true, r.call("ada", "poll")["unscored"]
    assert_equal 0, r.call("ada", "poll")["gained"]
    assert_equal r.call("ada", "poll")["streak"], r.call("ada", "wordcloud")["streak"], "a poll leaves a streak intact"
    assert_operator r.call("ada", "order")["streak"], :>=, 4, "streaks build on consecutive correct answers"
    assert_equal 0, r.call("grace", "order")["streak"]
    assert_equal "ada", the_end["leaderboard"][0]["name"]
    assert_equal({ "score" => the_end["leaderboard"][0]["score"], "rank" => 1, "players" => 3 }, @bus.on(room.player_stream("ada"), "game:end").last.except("event"))

    # ---------- report ----------
    game = Game.find(the_end["reportId"])
    assert_includes GameReport.listing(@user).map { |g| g["id"] }, game.id
    rep = GameReport.new(game).to_h
    assert_equal 8, rep["questions"].length, "every answered question is stored"
    assert_equal "1001", rep["players"].find { |p| p["name"] == "ada" }["identifier"]
    assert_equal [ 1, "ada" ], [ rep["players"][0]["rank"], rep["players"][0]["name"] ]
    assert_in_delta 2 / 3.0, rep["questions"].find { |q| q["type"] == "text" }["correctRate"]
    assert_nil rep["questions"].find { |q| q["type"] == "poll" }["correctRate"]
    assert rep["needsReview"].any? && rep["needsReview"].all? { |q| q["correctRate"] < 0.5 }
    assert_equal 8, rep["players"].find { |p| p["name"] == "ada" }["answers"].length

    csv = GameReport.new(game).to_csv
    assert_equal 1 + 24, csv.strip.split("\n").length
    assert_includes csv, '"11, 17"'
    assert_includes csv, ",1001,"
  end

  test "class lists decide who may join and name the absent" do
    room = room_for("sample", roster: "period3")
    assert_equal({ "title" => "Period 3 Biology", "count" => 5 }, room.describe["roster"])
    assert_equal "Not on the class list. Check your name or ID.", room.join("mallory", "Nobody")["error"]
    join(room, "ada", "1001")
    join(room, "alan", "Alan Turing")
    join(room, "grace", "  grace   HOPPER ")

    room.start
    4.times do
      %w[ada alan grace].each { |n| answer!(room, n, 0) }
      room.advance
    end
    rep = GameReport.new(Game.find(game_end(room)["reportId"])).to_h
    assert_equal [ "Ada Lovelace", "Alan Turing", "Grace Hopper" ], rep["players"].map { |p| p["identifier"] }.sort
    assert_equal [ "Charles Babbage", "Katherine Johnson" ], rep["roster"]["absent"].sort
  end

  test "an abandoned game leaves no report" do
    before = GameReport.listing(@user).length
    room = room_for("sample", host_grace_ms: 150)
    join(room, "x")
    room.start
    room.host_disconnected("host-1")
    assert_equal true, @bus.on(room.players_stream, "game:hostaway").last["away"]
    assert room.paused, "the game pauses while the host is away"
    assert Games::Registry.find(room.pin)
    sleep 0.5
    assert_nil Games::Registry.find(room.pin), "the room closes once the grace period runs out"
    assert_equal [ "game:closed" ], @bus.on(room.players_stream).map { |m| m["event"] }.last(1)
    assert_equal before, GameReport.listing(@user).length
    assert_nil Game.find_by(id: room.game.id)
  end

  test "pause, replay and jumping around" do
    room = room_for("sample")
    assert_equal 4, room.describe["questions"].length
    join(room, "ada")
    room.start
    q1 = host_question(room)
    assert_equal 20_000, q1["totalMs"]
    assert_equal 0, q1["index"]

    room.set_paused(true)
    pause = @bus.on(room.players_stream, "game:paused").last
    assert_equal true, pause["paused"]
    assert_nil pause["endsAt"], "the clock stops while paused"
    assert_equal "The host paused the game", room.record_answer("ada", 0)["error"]
    sleep 0.3
    room.set_paused(false)
    resume = @bus.on(room.players_stream, "game:paused").last
    assert_equal false, resume["paused"]
    assert_operator resume["remainingMs"], :>, 19_500, "paused time is not deducted"

    answer!(room, "ada", room.quiz["questions"][0]["answer"])
    after_q1 = player_results(room, "ada").last["score"]
    assert_operator after_q1, :>, 0

    # go back and replay question 1: the first award must be rolled back, not stacked
    room.prev
    assert_equal 0, host_question(room)["index"]
    answer!(room, "ada", room.quiz["questions"][0]["answer"])
    after_replay = player_results(room, "ada").last["score"]
    assert_operator after_replay, :<=, after_q1 + 50, "replaying does not award the question twice"
    assert_equal 1, room.game.game_answers.count, "the replayed answer replaces the first"

    room.jump(3)
    assert_equal 3, host_question(room)["index"]
    room.prev
    assert_equal 2, host_question(room)["index"], "back from a question means the previous one"
  end

  test "a host can come back to a running game" do
    room = room_for("sample")
    join(room, "ada")
    room.start
    room.host_disconnected("old-host")
    refute room.paused, "an older host connection going away changes nothing"
    room.host_disconnected("host-1")
    assert room.paused
    assert_equal true, @bus.on(room.players_stream, "game:hostaway").last["away"]

    room.host_connected("host-2")
    assert_equal false, @bus.on(room.players_stream, "game:hostaway").last["away"]
    replayed = host_question(room)
    assert_equal 0, replayed["index"]
    assert replayed["text"].present?, "the current question is replayed to the host"
    assert replayed["paused"], "and it is still paused until the host resumes"
    assert_equal "question", room.describe["state"]
  end

  test "phones receive the question text but never the answer" do
    room = room_for("all-types")
    join(room, "ada", "1001")
    room.start
    room.advance # past the slide
    q = @bus.on(room.player_stream("ada"), "game:question").last || @bus.on(room.players_stream, "game:question").last
    assert q["text"].present?
    assert_equal 4, q["labels"].length
    refute q.key?("answer")
    refute q.key?("answers")
    refute q.key?("explanation")
  end

  test "a reconnecting phone gets the open question again" do
    room = room_for("sample")
    join(room, "ada")
    join(room, "alan")
    room.start
    room.player_disconnected("ada", "conn-ada")
    refute room.players["ada"].connected
    assert room.players.key?("ada"), "leaving mid-game keeps the seat"
    @bus.clear
    room.player_connected("ada", "conn-ada-2")
    assert_equal 0, @bus.on(room.player_stream("ada"), "game:question").last["index"]
    room.player_disconnected("ada", "stale-conn")
    assert room.players["ada"].connected, "a stale connection going away is ignored"
  end

  test "explanations and a discussion re-vote" do
    room = room_for("all-types")
    %w[ada alan grace].zip(%w[1001 1002 1003]).each { |n, id| join(room, n, id) }
    room.start
    room.advance
    q = host_question(room)
    assert_equal "choice", q["type"]
    assert_equal false, q["revote"]

    right = q["choices"].index("Mars")
    wrong = (right + 1) % q["choices"].length
    answer!(room, "ada", right)
    answer!(room, "alan", wrong)
    answer!(room, "grace", wrong)
    first = host_results(room).last
    assert_includes first["explanation"], "iron oxide"
    assert_equal first["explanation"], player_results(room, "ada").last["explanation"]
    assert_equal true, first["suggestDiscussion"], "a split vote suggests discussion"
    assert_nil first["priorSummary"]
    first_counts = first["summary"]["counts"].dup

    room.revote
    again = host_question(room)
    assert_equal q["index"], again["index"]
    assert_equal true, again["revote"]
    %w[ada alan grace].each { |n| answer!(room, n, again["choices"].index("Mars")) }
    second = host_results(room).last
    assert_equal first_counts, second["priorSummary"]["counts"], "the first vote is kept for comparison"
    assert_equal 3, second["summary"]["counts"][again["choices"].index("Mars")]
    assert_operator player_results(room, "ada").last["score"], :<=, 1100, "the re-vote replaces the first score"
  end

  test "distractors and a review quiz" do
    room = room_for("sample")
    %w[ada alan grace].each { |n| join(room, n) }
    room.start
    4.times do |i|
      wrong = (room.quiz["questions"][i]["answer"] + 1) % 4
      %w[ada alan grace].each { |n| answer!(room, n, wrong) }
      room.advance
    end
    game = Game.find(game_end(room)["reportId"])
    rep = GameReport.new(game).to_h
    q0 = rep["questions"][0]
    assert_equal 4, q0["choices"].length
    assert_equal 3, q0["topDistractor"]["n"]
    assert_equal false, q0["topDistractor"]["correct"]
    assert_kind_of Integer, q0["sourceIdx"]

    review = GameReport.new(game).review_quiz(threshold: 0.6)
    assert_equal 4, review.body["questions"].length
    assert_equal 4, review.playable["questions"].length, "the review quiz is playable"
    assert_includes @user.quizzes.map(&:summary).map { |s| s["id"] }, review.slug
  end

  test "players on the same score share a rank" do
    room = room_for("sample")
    # joined in this order on purpose: ranking by position would have handed out
    # 1st, 2nd and 3rd in exactly this order regardless of how anyone played
    %w[ada bea cid dev].each { |n| join(room, n) }
    room.start
    q = host_question(room)
    right = q["choices"].index("Central Processing Unit")
    wrong = (right + 1) % q["choices"].length

    # one right, three wrong: a wrong answer always scores zero, so the losing
    # three are exactly level however fast they were
    answer!(room, "ada", right)
    %w[bea cid dev].each { |n| answer!(room, n, wrong) }

    board = host_results(room).last["leaderboard"]
    assert_equal "ada", board.first["name"]
    assert_equal [ 1, 2, 2, 2 ], board.map { |b| b["rank"] }, "equal scores share a rank"
    refute_includes board.map { |b| b["rank"] }, 3, "no third place is invented after a three-way tie"
    assert_equal 1, board.drop(1).map { |b| b["score"] }.uniq.length, "the tied players really are level"

    dev = player_results(room, "dev").last
    assert_equal 2, dev["rank"], "a tied player is told the rank they share"
    assert_equal "ada", dev["ahead"]["name"], "the gap is to someone ahead, not someone level"
    assert_operator dev["ahead"]["gap"], :>, 0
    assert_equal %w[bea cid], dev["levelWith"].sort, "a player is told who they are level with"
    assert_equal q["choices"][wrong], dev["yourAnswer"], "a player is told what they answered"
    assert_equal "everyone", dev["endedBy"], "a question everyone answered is reported as such"

    # the host cutting a question short must not be reported to the student as
    # being too slow, so the reason has to reach the phone
    room.advance
    answer!(room, "ada", 0)
    room.skip
    cut = player_results(room, "dev").last
    assert_equal "host", cut["endedBy"], "a question the host ended is marked as ended by the host"
    assert_equal false, cut["answered"]
    assert_nil cut["yourAnswer"], "with no answer there is nothing to read back"
  end

  test "nicknames, playing again and rehearsing alone" do
    room = room_for("sample")
    assert_match(/different nickname/, room.join("sh1thead", nil)["error"])
    refute room.join("A$$ Face", nil)["ok"]
    assert_equal "Enter a nickname", room.join("   ", nil)["error"]
    join(room, "Cassidy")
    assert_equal "That name is taken", room.join("Cassidy", nil)["error"]

    room.start
    4.times do
      answer!(room, "Cassidy", 0)
      room.advance
    end
    assert_operator game_end(room)["leaderboard"][0]["score"], :>=, 0
    first_game = room.game

    room.restart_if_over
    restarted = @bus.on(room.host_stream, "game:restarted").last
    assert_equal [ { "name" => "Cassidy", "score" => 0, "connected" => true } ], restarted["players"]
    assert_equal 1, @bus.on(room.players_stream, "game:restarted").length
    assert_equal "lobby", room.state
    refute_equal first_game.id, room.game.id, "a replay is recorded as a separate game"
    assert_equal [ "Cassidy" ], room.game.game_players.pluck(:name)

    # rehearsing alone leaves no report behind
    before = GameReport.listing(@user).length
    solo = room_for("sample")
    solo.start
    assert_equal "No players have joined yet", @bus.on(solo.host_stream, "game:error").last["message"]
    solo.start(solo: true)
    4.times do
      solo.skip
      solo.advance
    end
    the_end = game_end(solo)
    assert_nil the_end["reportId"]
    assert_equal true, the_end["solo"]
    assert_equal before, GameReport.listing(@user).length
    assert_nil Game.find_by(id: solo.game.id)

    students = GameReport.students(@user)
    assert_equal [ "Cassidy" ], students.map { |s| s["who"] }
    assert_equal 1, students[0]["gamesPlayed"]
  end

  test "the clock ends a question by itself" do
    quick = @user.quizzes.create!(slug: "quick", body: { "title" => "Quick", "questions" => [ { "text" => "Fast?", "choices" => %w[a b], "answer" => 0, "time" => 1 } ] })
    room = room_for("quick")
    join(room, "ada")
    join(room, "alan")
    room.start
    answer!(room, "ada", 0)
    assert_equal "question", room.state, "one of two answers keeps it open"
    sleep 1.6
    assert_equal "results", room.state
    r = player_results(room, "alan").last
    assert_equal false, r["answered"]
    assert_equal 0, r["gained"]
    assert_nil r["correct"], "no answer is neither right nor wrong"
    assert_equal "time", r["endedBy"], "the clock running out is not the host cutting in"
    room.advance
    assert game_end(room)
    assert quick.games.first.finished?
  end

  test "kicking removes a player" do
    room = room_for("sample")
    join(room, "ada")
    join(room, "bob")
    room.kick("ada")
    assert_equal [ "game:kicked" ], @bus.on(room.player_stream("ada")).map { |m| m["event"] }
    assert_equal [ "bob" ], @bus.on(room.host_stream, "lobby:players").last["players"].map { |p| p["name"] }
    room.player_disconnected("bob", "conn-bob")
    assert_empty room.players, "leaving the lobby frees the seat"
  end

  test "bad responses are refused with a reason" do
    room = room_for("all-types")
    join(room, "ada", "1001")
    room.start
    assert_equal "Nothing to answer here", room.record_answer("ada", 0)["error"]
    room.advance
    assert_equal "Invalid choice", room.record_answer("ada", 9)["error"]
    assert_equal "Invalid choice", room.record_answer("ada", "1")["error"]
    answer!(room, "ada", 1)
    assert_equal "No question open", room.record_answer("ada", 1)["error"]
  end
end
