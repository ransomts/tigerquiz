# frozen_string_literal: true

require_relative "plain_helper"
require "tigerquiz/quiz_document"
require "tigerquiz/roster_document"

class QuizDocumentTest < Minitest::Test
  D = Tigerquiz::QuizDocument

  def doc
    {
      "title" => "Planets", "note" => "n", "bogus" => 1, "shuffleAnswers" => true,
      "questions" => [
        { "text" => "Red?", "choices" => %w[Venus Mars Earth], "answer" => 1, "explanation" => "", "stray" => 2, "accept" => [] },
        { "type" => "multi", "text" => "Primes?", "choices" => %w[2 4 5 9], "answers" => [0, 2] },
        { "type" => "truefalse", "text" => "Sky blue?", "answer" => true }
      ]
    }
  end

  def test_validate_collects_every_problem
    r = D.validate({ "title" => " ", "questions" => [{ "text" => "x" }, { "text" => "", "choices" => %w[a b] }] })
    assert_equal ["Give the quiz a title", "question 1: needs 2-4 choices", "question 2: needs text"], r["problems"]
    assert_equal [], r["questions"]
    assert_equal ["Not an object"], D.validate("nope")["problems"]
    assert_equal ["Add at least one question"], D.validate({ "title" => "t", "questions" => [] })["problems"]
    assert_equal [], D.validate(doc)["problems"]
  end

  def test_pick_fields_drops_strays_and_blanks
    clean = D.pick_fields(doc)
    assert_equal %w[title note shuffleAnswers questions], clean.keys
    assert_equal({ "text" => "Red?", "choices" => %w[Venus Mars Earth], "answer" => 1 }, clean["questions"][0])
  end

  def test_load_normalises_and_checks_the_id
    quiz = D.load(doc, "planets")
    assert_equal %w[choice multi truefalse], quiz["questions"].map { |q| q["type"] }
    assert_equal true, quiz["phoneText"]
    assert_nil quiz["identifier"]
    assert_raises(Tigerquiz::InvalidQuestion) { D.load(doc, "../server") }
    assert_raises(Tigerquiz::InvalidQuestion) { D.load({ "questions" => [] }, "x") }
    assert_equal "x", D.load({ "questions" => [{ "text" => "q", "choices" => %w[a b], "answer" => 0 }] }, "x")["title"]
  end

  def test_prepare_shuffles_without_losing_the_answer
    quiz = D.load(doc.merge("shuffleQuestions" => true), "planets")
    50.times do |seed|
      played = D.prepare(quiz, random: Random.new(seed))
      assert_equal [0, 1, 2], played["questions"].map { |q| q["sourceIndex"] }.sort
      choice = played["questions"].find { |q| q["type"] == "choice" }
      assert_equal "Mars", choice["choices"][choice["answer"]]
      multi = played["questions"].find { |q| q["type"] == "multi" }
      assert_equal %w[2 5], multi["answers"].map { |i| multi["choices"][i] }.sort
      assert_equal multi["answers"].sort, multi["answers"]
      tf = played["questions"].find { |q| q["type"] == "truefalse" }
      assert_equal %w[True False], tf["choices"], "true/false keeps True first"
    end
  end

  def test_strip_internals_reads_like_a_hand_written_question
    q = Tigerquiz::Questions.normalize_question({ "text" => "q", "choices" => %w[a b], "answer" => 0, "image" => "pic name.png" }, 4)
    out = D.strip_internals(q)
    refute out.key?("sourceIndex")
    refute out.key?("type")
    refute out.key?("explanation")
    refute out.key?("discuss")
    assert_equal "pic name.png", out["image"]
  end

  def test_unique_slug
    taken = %w[review-x review-x-2]
    assert_equal "review-x-3", D.unique_slug("review-x") { |s| taken.include?(s) }
    assert_equal "a-b", D.unique_slug("a b!") { false }
    assert_equal "quiz", D.unique_slug("!!!") { false }
  end
end

class RosterDocumentTest < Minitest::Test
  R = Tigerquiz::RosterDocument

  def test_load_accepts_both_shapes
    plain = R.load(%w[Ada Alan], "p")
    assert_equal "p", plain["title"]
    assert_equal({ "name" => "Ada", "id" => nil }, plain["students"][0])
    full = R.load({ "title" => "P3", "students" => [{ "name" => "Ada", "id" => 1001 }] }, "p")
    assert_equal({ "name" => "Ada", "id" => "1001" }, full["students"][0])
    assert_raises(Tigerquiz::InvalidQuestion) { R.load({ "students" => [] }, "p") }
    assert_raises(Tigerquiz::InvalidQuestion) { R.load(%w[Ada], "bad id") }
  end

  def test_clean_students_drops_blanks
    out = R.clean_students([{ "name" => " Ada ", "id" => " 1 " }, { "name" => "Bob" }, { "name" => "  " }, "Cy", nil, { "name" => "Di", "id" => "" }])
    assert_equal [{ "name" => "Ada", "id" => "1" }, { "name" => "Bob" }, { "name" => "Cy" }, { "name" => "Di" }], out
  end

  def test_match_ignores_case_spacing_and_punctuation
    roster = R.load({ "students" => [{ "name" => "Ada Lovelace", "id" => "1001" }, { "name" => "Alan Turing" }] }, "p")
    assert_equal "Ada Lovelace", R.match(roster, "1001")["name"]
    assert_equal "Alan Turing", R.match(roster, "  alan   TURING. ")["name"]
    assert_nil R.match(roster, "Nobody")
    assert_nil R.match(roster, "")
  end
end
