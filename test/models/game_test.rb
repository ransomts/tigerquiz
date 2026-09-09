require "test_helper"

class GameTest < ActiveSupport::TestCase
  setup do
    @user = User.create!(eppn: "ada@example.edu")
    @game = @user.games.create!(pin: "123456", quiz_slug: "sample", title: "Sample", started_at: Time.zone.at(1_700_000_000))
  end

  test "games get a uuid and list with epoch milliseconds" do
    assert_match(/\A[0-9a-f-]{36}\z/, @game.id)
    listing = @game.listing
    assert_equal 1_700_000_000_000, listing["started_at"]
    assert_nil listing["ended_at"]
    assert_equal "sample", listing["quiz_id"]
  end

  test "unfinished games are discarded with their rows" do
    @game.game_questions.create!(idx: 0, question_type: "choice", text: "q")
    @game.game_players.create!(name: "ada")
    @game.game_answers.create!(idx: 0, player: "ada", response: 1, points: 900, correct: true)
    @game.discard_if_unfinished
    assert_nil Game.find_by(id: @game.id)
    assert_equal 0, GameAnswer.count
  end

  test "finished games are kept" do
    @game.update!(ended_at: Time.current)
    @game.discard_if_unfinished
    assert Game.exists?(@game.id)
    assert_equal [ @game.id ], Game.finished.map(&:id)
  end

  test "forget_from drops the replayed questions and answers" do
    2.times { |i| @game.game_questions.create!(idx: i, question_type: "choice", text: "q#{i}") }
    2.times { |i| @game.game_answers.create!(idx: i, player: "ada", response: 0) }
    @game.forget_from(1)
    assert_equal [ 0 ], @game.game_questions.pluck(:idx)
    assert_equal [ 0 ], @game.game_answers.pluck(:idx)
  end

  test "responses round-trip as json of any shape" do
    @game.game_answers.create!(idx: 0, player: "a", response: [ 0, 2 ])
    @game.game_answers.create!(idx: 0, player: "b", response: "gold")
    @game.game_answers.create!(idx: 0, player: "c", response: nil)
    assert_equal [ [ 0, 2 ], "gold", nil ], @game.game_answers.order(:player).map(&:response)
  end
end
