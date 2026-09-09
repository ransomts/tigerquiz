# frozen_string_literal: true

require_relative "plain_helper"

# Behaviour the parity fixture cannot pin down, mostly anything random.
class QuestionsTest < Minitest::Test
  Q = Tigerquiz::Questions

  def order_question
    Q.normalize_question({ "type" => "order", "text" => "Sort", "items" => %w[a b c d] }, 0)
  end

  def test_shuffled_is_a_permutation_and_seedable
    a = (0...20).to_a
    one = Q.shuffled(a, random: Random.new(7))
    two = Q.shuffled(a, random: Random.new(7))
    assert_equal one, two
    assert_equal a, one.sort
    assert_equal a, Q.shuffled([]) + a.sort
    refute_equal a, Q.shuffled(a, random: Random.new(1)) # 20! chances say so
  end

  def test_presentation_only_for_order
    assert_nil Q.presentation({ "type" => "choice" })
    shown = Q.presentation(order_question, random: Random.new(3))["shown"]
    assert_equal [0, 1, 2, 3], shown.sort
  end

  def test_order_round_trip_through_a_presentation
    q = order_question
    pres = Q.presentation(q, random: Random.new(5))
    # a player who puts the shown items back in their original order is fully right
    response = (0...4).map { |pos| pres["shown"].index(pos) }
    assert_equal({ "correct" => true, "ratio" => 1 }, Q.grade(q, Q.parse_response(q, response), pres))
    assert_equal q["items"], Q.host_view(q, pres)["items"].values_at(*response)
  end

  def test_player_view_never_leaks_the_answer
    q = Q.normalize_question({ "text" => "Which?", "choices" => %w[a b c], "answer" => 2, "explanation" => "why" }, 0)
    [false, true].each do |show|
      v = Q.player_view(q, nil, show_text: show)
      refute v.key?("answer")
      refute v.key?("explanation")
    end
    t = Q.normalize_question({ "type" => "text", "text" => "Spell", "accept" => ["cat"] }, 0)
    refute Q.player_view(t, nil, show_text: true).key?("accept")
  end

  def test_slider_partial_credit_tapers
    q = Q.normalize_question({ "type" => "slider", "text" => "?", "min" => 0, "max" => 100, "answer" => 50, "tolerance" => 10 }, 0)
    assert_equal 1, Q.grade(q, 60, nil)["ratio"]
    assert_in_delta 0.5, Q.grade(q, 65, nil)["ratio"]
    assert_equal 0, Q.grade(q, 70, nil)["ratio"]
    # integers must not fall into integer division
    assert_in_delta 0.9, Q.grade(q, 61, nil)["ratio"]
  end

  def test_text_fuzziness_is_length_aware
    q = Q.normalize_question({ "type" => "text", "text" => "?", "accept" => %w[cat photosynthesis] }, 0)
    assert Q.grade(q, "Cat", nil)["correct"]
    refute Q.grade(q, "cot", nil)["correct"], "four letters or fewer forgive nothing"
    assert Q.grade(q, "photosinthesis", nil)["correct"], "one typo"
    assert Q.grade(q, "fotosynthesis", nil)["correct"], "ph to f is two edits"
    refute Q.grade(q, "fotosinthesis", nil)["correct"], "three typos is too many"
    strict = Q.normalize_question({ "type" => "text", "text" => "?", "accept" => ["photosynthesis"], "fuzzy" => false }, 0)
    refute Q.grade(strict, "fotosynthesis", nil)["correct"]
  end

  def test_word_summary_keeps_first_spelling_and_is_stable
    q = Q.normalize_question({ "type" => "wordcloud", "text" => "?", "maxWords" => 3 }, 0)
    words = Q.summarize(q, nil, [["Cat"], %w[dog cat], ["CAT", "bird"], ["Dog"]])["words"]
    assert_equal [%w[Cat 3], %w[dog 2], %w[bird 1]], words.map { |w| [w["text"], w["n"].to_s] }
  end
end
