require_relative "boot"

# Only the frameworks the app uses. No mailer, storage, mailbox or text.
require "active_record/railtie"
require "active_job/railtie"
require "action_controller/railtie"
require "action_view/railtie"
require "action_cable/engine"
require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module Tigerquiz
  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 8.1

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # The host screen is opened by network name or IP, never localhost, so the
    # websocket must accept whatever origin the page itself was served from.
    config.action_cable.allow_same_origin_as_host = true

    # Served from a sub-path behind a reverse proxy (https://host/quiz/) when
    # RAILS_RELATIVE_URL_ROOT is set. config.ru mounts the app there, so routing
    # sees the prefix; this makes the app generate URLs with it too. Action Cable
    # is still mounted at /cable inside the app, but the page has to be told the
    # full path to open the websocket on, which is what config.action_cable.url is.
    if (relative_root = ENV["RAILS_RELATIVE_URL_ROOT"].presence)
      relative_root = "/#{relative_root.delete_prefix("/").delete_suffix("/")}"
      config.relative_url_root = relative_root
      config.action_cable.url = "#{relative_root}#{config.action_cable.mount_path || "/cable"}"
    end

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")
  end
end
