require "test_helper"

# The join endpoints and the nickname suggester are open by design: a PIN is
# what gets you into a game. That makes them the only unauthenticated way in,
# and six-digit PINs are few enough to walk through without a ceiling.
class RateLimitTest < ActionDispatch::IntegrationTest
  JSON_H = { "Content-Type" => "application/json" }.freeze

  setup do
    Games::Registry.reset!
    @ada = User.create!(eppn: "ada@example.edu")
    QuizImport.new(@ada, dir: Rails.root.join("quizzes")).run
  end

  teardown { Games::Registry.reset! }

  def lobby(pin) = post("/api/lobby", params: { pin: pin }.to_json, headers: JSON_H)

  test "walking the PIN space is cut off" do
    30.times { |i| lobby(format("%06d", i)) }
    assert_response :success, "a class of thirty phones is not an attack"

    lobby("999999")
    assert_response :too_many_requests
    assert_equal "Too many tries. Wait a moment and try again.", response.parsed_body["error"]
    assert_equal false, response.parsed_body["ok"]
  end

  test "joining and looking up a lobby share one ceiling" do
    25.times { |i| lobby(format("%06d", i)) }
    5.times { post "/api/join", params: { pin: "123456", name: "ada" }.to_json, headers: JSON_H }
    assert_response :success

    post "/api/join", params: { pin: "123456", name: "ada" }.to_json, headers: JSON_H
    assert_response :too_many_requests, "one limit covers both, so neither is a way round the other"
  end

  test "the dice button has a looser ceiling of its own" do
    60.times { get "/api/nickname" }
    assert_response :success
    get "/api/nickname"
    assert_response :too_many_requests
    # the join endpoints are counted separately, so a busy dice does not lock
    # a student out of actually joining
    lobby("123456")
    assert_response :success
  end

  test "a real game is nowhere near the limit" do
    game = post("/api/games", params: { quizId: "sample" }.to_json, headers: JSON_H.merge(as("ada@example.edu")))
    pin = response.parsed_body["pin"]
    lobby(pin)
    assert_response :success
    post "/api/join", params: { pin: pin, name: "ada" }.to_json, headers: JSON_H
    assert_equal true, response.parsed_body["ok"], response.parsed_body["error"]
  end
end
