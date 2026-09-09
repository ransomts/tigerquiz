class ApplicationController < ActionController::Base
  include Authentication
  # No allow_browser here: students join from whatever phone they have.

  private

  # The request body as plain JSON, exactly as the page sent it.
  def json_body
    body = request.raw_post.presence && JSON.parse(request.raw_post)
    body.is_a?(Hash) ? body : {}
  rescue JSON::ParserError
    {}
  end
end
