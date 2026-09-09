# This file is used by Rack-based servers to start the application.

require_relative "config/environment"

# Mounted under RAILS_RELATIVE_URL_ROOT when the proxy passes the prefix through
# (nginx proxy_pass without a URI, Apache ProxyPass /quiz/), so the routes match
# what the browser asked for. Unset, this is a plain mount at "/".
if (relative_root = ENV["RAILS_RELATIVE_URL_ROOT"].presence)
  map("/#{relative_root.delete_prefix("/").delete_suffix("/")}") { run Rails.application }
else
  run Rails.application
end
Rails.application.load_server
