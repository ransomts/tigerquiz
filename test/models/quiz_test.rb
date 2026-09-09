require "test_helper"

class QuizTest < ActiveSupport::TestCase
  setup do
    @user = User.create!(eppn: "ada@example.edu")
  end

  def body(extra = {})
    { "title" => "Planets", "questions" => [ { "text" => "Red one?", "choices" => %w[Venus Mars], "answer" => 1 } ] }.merge(extra)
  end

  test "a valid document saves and mirrors its title" do
    quiz = @user.quizzes.create!(slug: "planets", body: body)
    assert_equal "Planets", quiz.title
    assert_equal({ "id" => "planets", "title" => "Planets", "count" => 1 }, quiz.summary)
  end

  test "problems in the document are reported one per question" do
    quiz = @user.quizzes.build(slug: "bad", body: { "title" => "", "questions" => [ { "text" => "no choices" }, { "text" => "x", "choices" => %w[a b], "answer" => 9 } ] })
    refute quiz.valid?
    assert_equal [ "Give the quiz a title", "question 1: needs 2-4 choices", "question 2: answer must be an index into choices" ], quiz.errors[:body]
  end

  test "slugs are file-name safe and unique per user" do
    @user.quizzes.create!(slug: "week-1", body: body)
    dup = @user.quizzes.build(slug: "week-1", body: body)
    refute dup.valid?
    other = User.create!(eppn: "alan@example.edu")
    assert other.quizzes.build(slug: "week-1", body: body).valid?, "another instructor may reuse the slug"
    refute @user.quizzes.build(slug: "../escape", body: body).valid?
    refute @user.quizzes.build(slug: "has spaces!", body: body).valid?
  end

  test "playable normalises the questions" do
    quiz = @user.quizzes.create!(slug: "planets", body: body("identifier" => "  Student ID  "))
    play = quiz.playable
    assert_equal "planets", play["id"]
    assert_equal "Student ID", play["identifier"]
    assert_equal true, play["phoneText"]
    assert_equal 20, play["questions"][0]["time"]
    assert_equal 0, play["questions"][0]["sourceIndex"]
  end

  test "unique_slug appends a counter" do
    @user.quizzes.create!(slug: "review-planets", body: body)
    @user.quizzes.create!(slug: "review-planets-2", body: body)
    assert_equal "review-planets-3", Quiz.unique_slug(@user, "review-planets")
    assert_equal "fresh", Quiz.unique_slug(@user, "fresh")
  end
end
