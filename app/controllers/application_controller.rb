class ApplicationController < ActionController::Base
  include Authentication
  # No allow_browser here: students join from whatever phone they have.
end
