require "test_helper"

class AuthenticationTest < ActionDispatch::IntegrationTest
  test "the header identifies the instructor and creates them on first sight" do
    get "/api/me", headers: { "X-Remote-User" => "ada@example.edu", "X-Remote-Name" => "Ada Lovelace" }
    assert_response :success
    assert_equal({ "eppn" => "ada@example.edu", "name" => "Ada Lovelace", "role" => "instructor" }, response.parsed_body)
    assert_equal 1, User.count

    get "/api/me", headers: { "X-Remote-User" => "ada@example.edu" }
    assert_equal 1, User.count, "a second visit finds the same user"
    assert_equal "Ada Lovelace", User.first.display_name, "the name is kept when the header is absent"
  end

  test "without a header there is no user" do
    get "/api/me"
    assert_response :unauthorized
    assert_equal({ "error" => "Sign in required" }, response.parsed_body)
    assert_equal 0, User.count

    get "/api/me", headers: { "Accept" => "text/html" }
    assert_response :unauthorized
    assert_includes response.body, "Sign in required"
  end

  test "the header name is configurable" do
    Rails.application.config.tigerquiz.user_header = "X-Shib-Eppn"
    get "/api/me", headers: { "X-Remote-User" => "ignored@example.edu" }
    assert_response :unauthorized
    get "/api/me", headers: { "X-Shib-Eppn" => "alan@example.edu" }
    assert_response :success
    assert_equal "alan@example.edu", response.parsed_body["eppn"]
  ensure
    Rails.application.config.tigerquiz.user_header = "X-Remote-User"
  end

  test "the development fallback user is used outside production when configured" do
    Rails.application.config.tigerquiz.dev_user = "developer"
    get "/api/me"
    assert_response :success
    assert_equal "developer", response.parsed_body["eppn"]
  ensure
    Rails.application.config.tigerquiz.dev_user = nil
  end
end
