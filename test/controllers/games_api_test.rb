require "test_helper"

class GamesApiTest < ActionDispatch::IntegrationTest
  ADA = { "X-Remote-User" => "ada@example.edu" }.freeze
  ALAN = { "X-Remote-User" => "alan@example.edu" }.freeze
  JSON_H = { "Content-Type" => "application/json" }.freeze

  setup do
    Games::Registry.reset!
    @ada = User.create!(eppn: "ada@example.edu")
    QuizImport.new(@ada, dir: Rails.root.join("quizzes")).run
  end

  teardown { Games::Registry.reset! }

  def post_json(path, body, headers = {})
    post path, params: body.to_json, headers: headers.merge(JSON_H)
    response.parsed_body
  end

  test "a host creates a game and can resume it with the token" do
    game = post_json("/api/games", { quizId: "sample" }, ADA)
    assert_equal true, game["ok"], game["error"]
    assert_match(/\A\d{6}\z/, game["pin"])
    assert_operator game["hostToken"].length, :>, 10
    assert_equal 4, game["total"]
    assert_equal 4, game["questions"].length
    assert_equal "Sample Quiz", game["title"]
    assert_nil game["roster"]
    assert_equal 1, Game.count, "a record exists from the start, so a crash mid-game keeps the answers so far"

    back = post_json("/api/games/resume", { pin: game["pin"], token: game["hostToken"] }, ADA)
    assert_equal true, back["ok"]
    assert_equal "lobby", back["state"]
    assert_equal false, post_json("/api/games/resume", { pin: game["pin"], token: "not-the-token" }, ADA)["ok"]
    assert_equal false, post_json("/api/games/resume", { pin: game["pin"], token: game["hostToken"] }, ALAN)["ok"], "another instructor cannot take over"
  end

  test "a missing quiz or class list is refused" do
    assert_equal({ "ok" => false, "error" => "No such quiz" }, post_json("/api/games", { quizId: "does-not-exist" }, ADA))
    assert_equal({ "ok" => false, "error" => "No such quiz" }, post_json("/api/games", { quizId: "../server" }, ADA))
    assert_equal({ "ok" => false, "error" => "No such class list" }, post_json("/api/games", { quizId: "sample", rosterId: "nope" }, ADA))
    with_roster = post_json("/api/games", { quizId: "sample", rosterId: "period3" }, ADA)
    assert_equal({ "title" => "Period 3 Biology", "count" => 5 }, with_roster["roster"])
    post "/api/games", params: { quizId: "sample" }.to_json, headers: JSON_H
    assert_response :unauthorized
  end

  test "players look a game up and join it without signing in" do
    game = post_json("/api/games", { quizId: "all-types" }, ADA)
    assert_equal({ "ok" => true, "title" => "Every Question Type", "identifier" => "Student ID", "roster" => false }, post_json("/api/lobby", { pin: game["pin"] }))
    assert_equal({ "ok" => false, "error" => "Game not found" }, post_json("/api/lobby", { pin: "000000" }))
    assert_equal({ "ok" => false, "error" => "Game not found" }, post_json("/api/join", { pin: "000000", name: "ada" }))

    assert_equal "Enter your Student ID", post_json("/api/join", { pin: game["pin"], name: "ada" })["error"]
    joined = post_json("/api/join", { pin: game["pin"], name: "ada", identifier: "1001" })
    assert_equal true, joined["ok"]
    assert_equal "ada", joined["name"]
    assert_equal "lobby", joined["state"]
    assert_operator joined["token"].length, :>, 10
    assert_equal [ "ada" ], Games::Registry.find(game["pin"]).players.keys

    Games::Registry.find(game["pin"]).player_connected("ada", "c1")
    assert_equal "That name is taken", post_json("/api/join", { pin: game["pin"], name: "ada", identifier: "1001" })["error"]
    assert_equal "Pick a different nickname", post_json("/api/join", { pin: game["pin"], name: "sh1t", identifier: "1001" })["error"]
  end

  test "the player page is public and the host page is not" do
    get "/"
    assert_response :success
    assert_includes response.body, "Game PIN"
    get "/host"
    assert_response :unauthorized
    get "/host", headers: ADA
    assert_response :success
    assert_includes response.body, "Create game"
  end
end
