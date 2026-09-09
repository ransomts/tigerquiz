require "test_helper"

# The policy is only worth having if it keeps holding. These pin the parts that
# a later change could quietly undo: the nonce that lets each page's own script
# run, and the absence of a blanket 'unsafe-inline' on script-src.
class SecurityHeadersTest < ActionDispatch::IntegrationTest
  setup { User.create!(eppn: "ada@example.edu") }

  def policy = response.headers["Content-Security-Policy"]

  test "the join page carries a policy and a nonce its own script can use" do
    get "/"
    assert_response :success
    assert_match(/script-src 'self' 'nonce-[^']+'/, policy)
    assert_no_match(/script-src[^;]*unsafe-inline/, policy, "a nonce is pointless beside unsafe-inline")
    nonce = policy[/script-src 'self' 'nonce-([^']+)'/, 1]
    assert_includes response.body, %(<script nonce="#{nonce}">), "the page's own script has to carry the nonce"
  end

  test "each response gets its own nonce" do
    get "/"
    first = policy
    get "/"
    assert_not_equal first, policy, "a nonce reused across responses is a nonce an attacker can predict"
  end

  test "the instructor pages carry it too" do
    %w[/host /edit /reports].each do |path|
      get path, headers: as("ada@example.edu")
      assert_response :success
      assert_not_nil policy[/script-src 'self' 'nonce-([^']+)'/, 1], "#{path} has no nonce"
    end
  end

  test "every inline script on every page carries the nonce" do
    # The editor keeps all its JS in assets and has no inline script; the other
    # pages each have one. Whichever it is, an un-nonced inline script would be
    # silently dead under this policy rather than loudly broken.
    { "/" => nil, "/host" => "ada@example.edu", "/edit" => "ada@example.edu", "/reports" => "ada@example.edu" }.each do |path, eppn|
      get path, headers: eppn ? as(eppn) : {}
      nonce = policy[/script-src 'self' 'nonce-([^']+)'/, 1]
      inline = response.body.scan(/<script(?![^>]*\bsrc=)[^>]*>/)
      inline.each do |tag|
        assert_includes tag, %(nonce="#{nonce}"), "#{path} has an inline script without the nonce: #{tag}"
      end
    end
  end

  test "the policy shuts the doors that do not need to be open" do
    get "/"
    assert_match(/object-src 'none'/, policy)
    assert_match(/base-uri 'self'/, policy)
    assert_match(/form-action 'self'/, policy)
    assert_match(/frame-ancestors 'self'/, policy)
  end
end
