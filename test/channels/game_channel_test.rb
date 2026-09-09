require "test_helper"

class GameChannelTest < ActionCable::Channel::TestCase
  setup do
    Games::Registry.reset!
    @user = User.create!(eppn: "ada@example.edu")
    QuizImport.new(@user, dir: Rails.root.join("quizzes")).run
    @bus = Games::RecordingBus.new
    @room = Games::Registry.create(quiz: @user.quizzes.find_by!(slug: "sample").playable, roster: nil, user: @user, bus: @bus)
  end

  teardown { Games::Registry.reset! }

  test "the host subscribes with the game's token" do
    subscribe pin: @room.pin, role: "host", token: @room.host_token
    assert subscription.confirmed?
    assert_has_stream @room.host_stream
    assert_equal "lobby:players", @bus.on(@room.host_stream).last["event"]
  end

  test "a wrong token or an unknown game is rejected" do
    subscribe pin: @room.pin, role: "host", token: "nope"
    assert subscription.rejected?
    subscribe pin: "000000", role: "host", token: @room.host_token
    assert subscription.rejected?
    subscribe pin: @room.pin, role: "player", name: "ghost", token: "x"
    assert subscription.rejected?
  end

  test "host actions drive the room" do
    subscribe pin: @room.pin, role: "host", token: @room.host_token
    @room.join("ada", nil)
    @room.player_connected("ada", "c1")
    perform :start, {}
    assert_equal "question", @room.state
    perform :pause, { "paused" => true }
    assert @room.paused
    perform :pause, { "paused" => false }
    refute @room.paused
    perform :skip, {}
    assert_equal "results", @room.state
    perform :advance, {}
    assert_equal 1, @room.q_index
    perform :goto, { "index" => 3 }
    assert_equal 3, @room.q_index
    perform :kick, { "name" => "ada" }
    assert_empty @room.players
    unsubscribe
    assert @room.paused, "the host leaving pauses the game"
  end

  test "a player subscribes, answers with an acknowledgement, and leaves" do
    res = @room.join("ada", nil)
    subscribe pin: @room.pin, role: "player", name: "ada", token: res["token"]
    assert subscription.confirmed?
    assert_has_stream @room.players_stream
    assert_has_stream @room.player_stream("ada")
    assert @room.players["ada"].connected

    @room.host_connected("h")
    @room.start
    perform :answer, { "response" => 9, "seq" => 6 }
    assert_equal({ "ok" => false, "error" => "Invalid choice", "event" => "answer:ack", "seq" => 6 }, transmissions.last)
    perform :answer, { "response" => 0, "seq" => 7 }
    assert_equal({ "ok" => true, "event" => "answer:ack", "seq" => 7 }, transmissions.last)
    assert_equal "results", @room.state, "the only player answering ends the question"

    unsubscribe
    refute @room.players["ada"].connected
  end

  test "a player cannot use host actions" do
    res = @room.join("ada", nil)
    subscribe pin: @room.pin, role: "player", name: "ada", token: res["token"]
    perform :start, {}
    assert_equal "lobby", @room.state
  end
end
