require "test_helper"

# Behind a proxy the app can be served from a sub-path (https://host/quiz/).
# config.ru mounts it there, which reaches the app as SCRIPT_NAME, and every
# URL a page fetches has to be built from that rather than assumed to be "/".
class SubPathTest < ActionDispatch::IntegrationTest
  ADA = { "X-Remote-User" => "ada@example.edu" }.freeze
  UNDER_QUIZ = { "SCRIPT_NAME" => "/quiz" }.freeze

  setup { User.create!(eppn: "ada@example.edu") }

  test "an instructor page carries the mount point its scripts build URLs from" do
    get "/host", headers: ADA, env: UNDER_QUIZ
    assert_response :success
    assert_select "meta[name=app-base][content=?]", "/quiz/"
    assert_select "link[rel=icon][href=?]", "/quiz/icon.svg"
    assert_select "a[href=?]", "/quiz/edit"
    assert_select "a[href=?]", "/quiz/reports"
  end

  test "the join page carries it too, since phones are sent there by QR" do
    get "/", env: UNDER_QUIZ
    assert_response :success
    assert_select "meta[name=app-base][content=?]", "/quiz/"
  end

  test "served from the root, nothing gains a prefix" do
    get "/host", headers: ADA
    assert_select "meta[name=app-base][content=?]", "/"
    assert_select "link[rel=icon][href=?]", "/icon.svg"
    assert_select "a[href=?]", "/edit"
  end

  test "the page says where the websocket is" do
    get "/host", headers: ADA
    assert_select "meta[name=action-cable-url][content=?]", ActionCable.server.config.url || "/cable"
  end
end
