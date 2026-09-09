require "test_helper"

# Reports over a finished game whose rows are written by hand, the way the game
# engine writes them. Mirrors the report checks in test/game.test.mjs.
class ReportsApiTest < ActionDispatch::IntegrationTest
  ADA = { "X-Remote-User" => "ada@example.edu" }.freeze
  ALAN = { "X-Remote-User" => "alan@example.edu" }.freeze

  setup do
    @ada = User.create!(eppn: "ada@example.edu")
    @quiz = @ada.quizzes.create!(slug: "planets", body: {
      "title" => "Planets", "shuffleAnswers" => true,
      "questions" => [
        { "text" => "Red planet?", "choices" => %w[Venus Mars Jupiter Saturn], "answer" => 1, "explanation" => "Iron oxide" },
        { "type" => "text", "text" => "Symbol for gold?", "accept" => %w[Au] },
        { "type" => "poll", "text" => "Favourite, honestly?", "choices" => %w[Mars Venus] },
        { "text" => "Biggest?", "choices" => %w[Earth Jupiter], "answer" => 1 }
      ]
    })
    @roster = @ada.rosters.create!(slug: "p3", title: "Period 3", students: [
      { "name" => "Ada Lovelace", "id" => "1001" }, { "name" => "Alan Turing", "id" => "1002" }, { "name" => "Grace Hopper" }, { "name" => "Charles Babbage" }
    ])
    @game = @ada.games.create!(quiz: @quiz, roster: @roster, pin: "123456", quiz_slug: "planets", title: "Planets",
                               started_at: Time.utc(2026, 9, 9, 10, 0), ended_at: Time.utc(2026, 9, 9, 10, 20), question_count: 4, player_count: 3)
    # question order was shuffled at play time: the text question came first
    @game.game_questions.create!(idx: 0, question_type: "text", text: "Symbol for gold?", answer: "Au", source_idx: 1, correct_answer: nil)
    @game.game_questions.create!(idx: 1, question_type: "choice", text: "Red planet?", answer: "Mars", choices: %w[Venus Mars Jupiter Saturn], explanation: "Iron oxide", source_idx: 0, correct_answer: 1)
    @game.game_questions.create!(idx: 2, question_type: "poll", text: "Favourite, honestly?", choices: %w[Mars Venus], source_idx: 2, correct_answer: nil)
    @game.game_questions.create!(idx: 3, question_type: "choice", text: "Biggest?", answer: "Jupiter", choices: %w[Earth Jupiter], source_idx: 3, correct_answer: 1)
    # correct and scored are what finishing a game writes onto the player row,
    # counted here by hand from the answers below so the list has nothing to sum
    @game.game_players.create!(name: "ada", identifier: "Ada Lovelace", score: 2900, rank: 1, correct: 3, scored: 3)
    @game.game_players.create!(name: "alan", identifier: "Alan Turing", score: 1800, rank: 2, correct: 2, scored: 3)
    @game.game_players.create!(name: "grace", identifier: "Grace Hopper", score: 900, rank: 3, correct: 1, scored: 3)
    rows = [
      [ 0, "ada", "Au", 1200, true, 970 ], [ 0, "alan", "au", 3000, true, 925 ], [ 0, "grace", "Ag", 2000, false, 0 ],
      [ 1, "ada", 1, 1000, true, 1075 ], [ 1, "alan", 0, 1500, false, 0 ], [ 1, "grace", 0, 900, false, 0 ],
      [ 2, "ada", 0, 500, nil, 0 ], [ 2, "alan", 1, 500, nil, 0 ], [ 2, "grace", 0, 500, nil, 0 ],
      [ 3, "ada", 1, 800, true, 855 ], [ 3, "alan", 1, 600, true, 875 ], [ 3, "grace", 1, 700, true, 900 ]
    ]
    rows.each { |idx, player, response, ms, correct, points| @game.game_answers.create!(idx: idx, player: player, response: response, ms: ms, correct: correct, points: points) }
  end

  test "finished games are listed for their owner only" do
    @ada.games.create!(pin: "1", quiz_slug: "planets", title: "Abandoned", started_at: Time.current)
    get "/api/reports", headers: ADA
    assert_equal [ @game.id ], response.parsed_body.map { |g| g["id"] }
    assert_equal 1_788_948_000_000, response.parsed_body[0]["started_at"]
    get "/api/reports", headers: ALAN
    assert_equal [], response.parsed_body
    get "/api/reports/#{@game.id}", headers: ALAN
    assert_response :not_found
  end

  test "the report breaks the game down by question and player" do
    get "/api/reports/#{@game.id}", headers: ADA
    r = response.parsed_body
    assert_equal "Planets", r["game"]["title"]
    assert_equal 4, r["questions"].length

    text = r["questions"][0]
    assert_in_delta 2 / 3.0, text["correctRate"]
    assert_equal 2067, text["avgMs"]
    assert_equal [ { "label" => "Au", "n" => 2, "correct" => true }, { "label" => "Ag", "n" => 1, "correct" => false } ], text["distractors"], "case variants merge"
    assert_nil text["topDistractor"], "a single stray pick is not a pattern"

    choice = r["questions"][1]
    assert_equal 0, choice["sourceIdx"]
    assert_equal "Iron oxide", choice["explanation"]
    assert_equal [ { "label" => "Venus", "n" => 2, "correct" => false }, { "label" => "Mars", "n" => 1, "correct" => true } ], choice["distractors"]
    assert_equal "Venus", choice["topDistractor"]["label"]

    poll = r["questions"][2]
    assert_nil poll["correctRate"], "polls are excluded from correct rate"
    assert_nil poll["distractors"][0]["correct"]

    assert_equal [ "Red planet?" ], r["needsReview"].map { |q| q["text"] }

    assert_equal %w[ada alan grace], r["players"].map { |p| p["name"] }
    ada = r["players"][0]
    assert_equal "Ada Lovelace", ada["identifier"]
    assert_equal 1, ada["rank"]
    assert_equal 4, ada["answered"]
    assert_equal 3, ada["correct"]
    assert_equal 3, ada["scored"]
    assert_equal({ "idx" => 1, "response" => 1, "correct" => true, "points" => 1075, "ms" => 1000 }, ada["answers"][1])

    assert_equal({ "title" => "Period 3", "total" => 4, "absent" => [ "Charles Babbage" ] }, r["roster"])
  end

  test "the csv holds a row per player per question and quotes commas" do
    @game.game_answers.find_by(idx: 0, player: "ada").update!(response: [ "11", "17" ])
    get "/api/reports/#{@game.id}/csv", headers: ADA
    assert_response :success
    assert_equal "text/csv", response.media_type
    assert_includes response.headers["Content-Disposition"], 'filename="Planets_2026-09-09.csv"'
    lines = response.body.split("\n")
    assert_equal 13, lines.length
    assert_equal "player,identifier,rank,total_score,question,type,question_text,correct_answer,response,correct,points,seconds", lines[0]
    assert_includes response.body, "ada,Ada Lovelace,1,2900,1,text,Symbol for gold?,Au,11 | 17,yes,970,1.2"
    assert_includes response.body, 'grace,Grace Hopper,3,900,3,poll,"Favourite, honestly?",,0,,0,0.5'
  end

  test "a review quiz is built from the questions the class missed" do
    post "/api/reports/#{@game.id}/review-quiz", params: { threshold: 0.6 }.to_json, headers: ADA.merge("Content-Type" => "application/json")
    made = response.parsed_body
    assert_equal true, made["ok"], made["error"]
    assert_equal "review-planets", made["id"]
    assert_equal "Review: Planets", made["title"]
    assert_equal 1, made["count"]
    review = @ada.quizzes.find_by!(slug: "review-planets")
    assert_equal [ "Red planet?" ], review.body["questions"].map { |q| q["text"] }
    assert_equal "Questions the class missed on 2026-09-09", review.body["note"]
    assert_equal true, review.body["shuffleQuestions"]
    refute review.body["questions"][0].key?("sourceIndex")
    assert_equal 1, review.playable["questions"].length, "the review quiz is playable"

    post "/api/reports/#{@game.id}/review-quiz", params: { threshold: 0.6 }.to_json, headers: ADA.merge("Content-Type" => "application/json")
    assert_equal "review-planets-2", response.parsed_body["id"], "a second review quiz gets a new id"

    post "/api/reports/#{@game.id}/review-quiz", params: { threshold: 0.1 }.to_json, headers: ADA.merge("Content-Type" => "application/json")
    assert_response :bad_request
    assert_equal "Nothing was missed often enough to review", response.parsed_body["error"]
  end

  test "reports can be deleted" do
    delete "/api/reports/#{@game.id}", headers: ADA
    assert_equal({ "ok" => true }, response.parsed_body)
    assert_equal 0, Game.count
    assert_equal 0, GameAnswer.count
  end

  test "students are followed across games" do
    get "/api/students", headers: ADA
    students = response.parsed_body
    assert_equal [ "Ada Lovelace", "Alan Turing", "Grace Hopper" ], students.map { |s| s["who"] }
    ada = students[0]
    assert_equal [ "ada" ], ada["nicknames"]
    assert_equal 1, ada["gamesPlayed"]
    assert_equal 3, ada["correct"]
    assert_equal 3, ada["scored"]
    assert_equal 1.0, ada["correctRate"]
    assert_equal({ "gameId" => @game.id, "title" => "Planets", "startedAt" => 1_788_948_000_000, "score" => 2900, "rank" => 1, "correct" => 3, "scored" => 3 }, ada["games"][0])
    get "/api/students", headers: ALAN
    assert_equal [], response.parsed_body
  end
end
