require "test_helper"

# The editor's API, following test/game.test.mjs's editor suite from the Node version.
class QuizzesApiTest < ActionDispatch::IntegrationTest
  ADA = { "X-Remote-User" => "ada@example.edu" }.freeze
  ALAN = { "X-Remote-User" => "alan@example.edu" }.freeze

  DRAFT = {
    "title" => "Editor Test",
    "phoneText" => true,
    "questions" => [
      { "type" => "choice", "text" => "Pick one", "choices" => %w[a b], "answer" => 1, "time" => 15, "explanation" => "because b" },
      { "type" => "truefalse", "text" => "Water is wet", "answer" => 0 }
    ]
  }.freeze

  def put_quiz(id, body, headers: ADA)
    put "/api/quiz/#{id}", params: body.to_json, headers: headers.merge("Content-Type" => "application/json")
    response.parsed_body
  end

  test "an invalid quiz is refused with reasons" do
    bad = put_quiz("editor-test", { "title" => "", "questions" => [ { "text" => "no choices" } ] })
    assert_response :bad_request
    assert_equal "Fix these first", bad["error"]
    assert_equal [ "Give the quiz a title", "question 1: needs 2-4 choices" ], bad["problems"]
    assert_equal 0, Quiz.count
  end

  test "unsafe ids are refused" do
    put_quiz(CGI.escape("../escape"), DRAFT)
    assert_includes [ 400, 404 ], response.status, "a traversing id never reaches the model"
    assert_match(/letters, digits/, put_quiz(CGI.escape("has spaces!"), DRAFT)["error"])
    get "/api/quiz/#{CGI.escape("../x")}", headers: ADA
    assert_includes [ 400, 404 ], response.status
  end

  test "a valid quiz saves, reads back clean and is listed" do
    saved = put_quiz("editor-test", DRAFT.merge("bogus" => "nope"))
    assert_response :success
    assert_equal({ "ok" => true, "id" => "editor-test", "count" => 2 }, saved)

    get "/api/quiz/editor-test", headers: ADA
    back = response.parsed_body
    assert_equal "Editor Test", back["title"]
    assert_equal 2, back["questions"].length
    refute back.key?("bogus"), "stray fields are stripped"
    refute back["questions"][1].key?("explanation"), "empty fields are not written"

    get "/api/quizzes", headers: ADA
    assert_equal [ { "id" => "editor-test", "title" => "Editor Test", "count" => 2 } ], response.parsed_body

    put_quiz("editor-test", DRAFT.merge("title" => "Renamed"))
    assert_equal 1, Quiz.count, "saving again updates rather than duplicates"
    assert_equal "Renamed", Quiz.first.title
  end

  test "quizzes belong to the instructor who wrote them" do
    put_quiz("mine", DRAFT)
    get "/api/quiz/mine", headers: ALAN
    assert_response :not_found
    get "/api/quizzes", headers: ALAN
    assert_equal [], response.parsed_body
    put_quiz("mine", DRAFT.merge("title" => "Alan's"), headers: ALAN)
    assert_equal 2, Quiz.count, "another instructor gets their own quiz under the same id"
    delete "/api/quiz/mine", headers: ALAN
    get "/api/quiz/mine", headers: ADA
    assert_equal "Editor Test", response.parsed_body["title"], "deleting theirs leaves mine"
  end

  test "a draft can be checked without saving" do
    post "/api/quiz-check", params: { "title" => "x", "questions" => [ { "text" => "q", "choices" => [ "a" ], "answer" => 0 } ] }.to_json,
                            headers: ADA.merge("Content-Type" => "application/json")
    assert_equal({ "ok" => false, "problems" => [ "question 1: needs 2-4 choices" ], "count" => 0 }, response.parsed_body)
    assert_equal 0, Quiz.count
  end

  test "quizzes can be deleted" do
    put_quiz("editor-test", DRAFT)
    delete "/api/quiz/editor-test", headers: ADA
    assert_equal({ "ok" => true }, response.parsed_body)
    get "/api/quiz/editor-test", headers: ADA
    assert_response :not_found
    delete "/api/quiz/editor-test", headers: ADA
    assert_response :not_found
  end

  test "class lists save, drop blank rows, read back and delete" do
    put "/api/roster/editor-class", params: { "title" => "Editor Class", "students" => [ { "name" => "Ada", "id" => "1" }, { "name" => "Bob" }, { "name" => "  " } ] }.to_json,
                                    headers: ADA.merge("Content-Type" => "application/json")
    assert_equal({ "ok" => true, "id" => "editor-class", "count" => 2 }, response.parsed_body)
    get "/api/roster/editor-class", headers: ADA
    assert_equal({ "title" => "Editor Class", "students" => [ { "name" => "Ada", "id" => "1" }, { "name" => "Bob" } ] }, response.parsed_body)
    get "/api/rosters", headers: ADA
    assert_equal [ { "id" => "editor-class", "title" => "Editor Class", "count" => 2 } ], response.parsed_body
    get "/api/rosters", headers: ALAN
    assert_equal [], response.parsed_body

    put "/api/roster/empty", params: { "students" => [] }.to_json, headers: ADA.merge("Content-Type" => "application/json")
    assert_response :bad_request
    assert_equal "Add at least one student", response.parsed_body["error"]

    delete "/api/roster/editor-class", headers: ADA
    assert_equal({ "ok" => true }, response.parsed_body)
    get "/api/roster/editor-class", headers: ADA
    assert_response :not_found
  end

  test "the api needs a signed-in instructor" do
    get "/api/quizzes"
    assert_response :unauthorized
    put "/api/quiz/x", params: DRAFT.to_json, headers: { "Content-Type" => "application/json" }
    assert_response :unauthorized
  end

  test "the editor and host pages render for an instructor" do
    get "/edit", headers: ADA
    assert_response :success
    assert_includes response.body, "Quiz editor"
    get "/reports", headers: ADA
    assert_response :success
    assert_includes response.body, "Game reports"
    get "/edit"
    assert_response :unauthorized
  end

  test "nicknames, qr codes and images are public" do
    get "/api/nickname"
    assert_match(/\A[A-Z][a-z]+[A-Z][a-z]+\z/, response.parsed_body["name"])

    get "/api/qr.svg", params: { text: "http://example.test/?pin=123456" }
    assert_response :success
    assert_equal "image/svg+xml", response.media_type
    assert_includes response.body, "<svg"
    get "/api/qr.svg"
    assert_response :bad_request

    get "/quiz-images/shape.svg"
    assert_response :success
    assert_equal "image/svg+xml", response.media_type
    get "/quiz-images/nope.png"
    assert_response :not_found
    get "/quiz-images/..%2F..%2FGemfile"
    assert_response :not_found, "only the file name counts"
  end
end
