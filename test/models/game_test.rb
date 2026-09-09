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

  test "finishing a game counts each player's correctness onto their row" do
    @game.game_players.create!(name: "ada")
    @game.game_players.create!(name: "alan")
    [ [ 0, "ada", true ], [ 1, "ada", true ], [ 2, "ada", nil ],
      [ 0, "alan", false ], [ 1, "alan", true ], [ 2, "alan", nil ] ].each do |idx, player, correct|
      @game.game_answers.create!(idx: idx, player: player, response: 0, correct: correct)
    end

    @game.finish!([ { "name" => "ada", "score" => 1900, "rank" => 1 }, { "name" => "alan", "score" => 900, "rank" => 2 } ], 3)

    ada, alan = @game.game_players.order(:name).to_a
    assert_equal [ 2, 2 ], [ ada.correct, ada.scored ]
    # the poll at idx 2 has no right answer, so it counts for nobody
    assert_equal [ 1, 2 ], [ alan.correct, alan.scored ]
  end

  test "a replayed question cannot leave the counts disagreeing with the answers" do
    @game.game_players.create!(name: "ada")
    2.times { |i| @game.game_answers.create!(idx: i, player: "ada", response: 0, correct: true) }
    # the host went back and ada got it wrong the second time round
    @game.forget_from(1)
    @game.game_answers.create!(idx: 1, player: "ada", response: 1, correct: false)

    @game.finish!([ { "name" => "ada", "score" => 900, "rank" => 1 } ], 2)
    assert_equal [ 1, 2 ], @game.game_players.first.then { |p| [ p.correct, p.scored ] }
  end

  test "unfinished games left by an earlier run are swept" do
    finished = @user.games.create!(pin: "2", quiz_slug: "sample", title: "Done", started_at: Time.current, ended_at: Time.current)
    @game.game_answers.create!(idx: 0, player: "ada", response: 0)

    assert_equal 1, Game.sweep_unfinished!
    assert_equal [ finished.id ], Game.pluck(:id)
    assert_equal 0, GameAnswer.count, "the rows the abandoned game held go with it"
  end

  test "responses round-trip as json of any shape" do
    @game.game_answers.create!(idx: 0, player: "a", response: [ 0, 2 ])
    @game.game_answers.create!(idx: 0, player: "b", response: "gold")
    @game.game_answers.create!(idx: 0, player: "c", response: nil)
    assert_equal [ [ 0, 2 ], "gold", nil ], @game.game_answers.order(:player).map(&:response)
  end
end
