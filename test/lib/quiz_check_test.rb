# frozen_string_literal: true

require_relative "plain_helper"
require "stringio"

class QuizCheckTest < Minitest::Test
  BAD = File.join(FIXTURES, "bad-quizzes")

  def run_check(wanted = [], quiz_dir: nil)
    out = StringIO.new
    opts = { root: PROJECT_ROOT, out: out, color: false }
    opts[:quiz_dir] = quiz_dir if quiz_dir
    status = Tigerquiz::QuizCheck.new(**opts).run(wanted)
    [status, out.string]
  end

  # The JSON parsers word their complaints differently; everything else must match.
  def normalise(text)
    text.gsub(/not valid JSON: .*/, "not valid JSON")
  end

  def test_matches_the_node_checker_on_the_shipped_quizzes
    status, out = run_check
    assert_equal 0, status
    assert_equal File.read(File.join(FIXTURES, "check-output.txt")), out
  end

  def test_matches_the_node_checker_on_broken_quizzes
    files = ["broken.json", "notjson.json", "empty.json", "bad name!.json", "missing.json"].map { |f| File.join(BAD, f) }
    status, out = run_check(files)
    assert_equal 1, status
    expected = File.read(File.join(FIXTURES, "bad-check-output.txt"))
    assert_equal normalise(expected), normalise(out)
  end

  def test_images_are_looked_up_beside_the_quizzes
    _, out = run_check([File.join(BAD, "broken.json")], quiz_dir: BAD)
    assert_includes out, %(image "missing.png" not found)
    refute_includes out, %(image "present.png" not found)
  end

  def test_rosters
    status, out = run_check(quiz_dir: BAD)
    assert_equal 1, status
    assert_includes out, "test/fixtures/bad-quizzes/rosters/broken.json\n  error   no students\n"
    dupes = <<~OUT
      test/fixtures/bad-quizzes/rosters/dupes.json
        error   "ada lovelace" cannot be told apart from "Ada Lovelace"
        error   id "1" is used by both ada lovelace and Alan Turing
        error   student 4 has no name
        warning 3 of 5 students have no id
        5 students
    OUT
    assert_includes out, dupes
    assert_includes out, "test/fixtures/bad-quizzes/rosters/plain.json\n  2 students\n"
  end

  def test_a_named_quiz_by_id
    status, out = run_check(["all-types"])
    assert_equal 0, status
    assert_includes out, "quizzes/all-types.json\n  9/9 questions valid"
    refute_includes out, "rosters", "named quizzes skip the roster check, like the Node version"
    assert_includes out, "\nAll good\n"
  end

  def test_no_quizzes
    Dir.mktmpdir do |dir|
      status, out = run_check(quiz_dir: dir)
      assert_equal 1, status
      assert_equal "No quiz files found in quizzes/\n", out
    end
  end
end
