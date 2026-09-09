# Application settings, all overridable from the environment.
Rails.application.config.tigerquiz = ActiveSupport::OrderedOptions.new.tap do |c|
  # Apache sets this header from the Shibboleth session (see PORT.md).
  c.user_header = ENV.fetch("TIGERQUIZ_USER_HEADER", "X-Remote-User")
  c.name_header = ENV.fetch("TIGERQUIZ_NAME_HEADER", "X-Remote-Name")
  # who you are when there is no header. Development defaults to "developer";
  # tests must set the header (or TIGERQUIZ_DEV_USER) explicitly; production never falls back.
  c.dev_user = ENV["TIGERQUIZ_DEV_USER"].presence || (Rails.env.development? ? "developer" : nil)
  # quiz files to import, and the images they refer to
  c.quiz_dir = Pathname.new(ENV.fetch("TIGERQUIZ_QUIZZES", Rails.root.join("quizzes")))
  c.image_dir = Pathname.new(ENV.fetch("TIGERQUIZ_IMAGES", Rails.root.join("quizzes", "images")))
  # how long a game waits for a host whose browser dropped
  c.host_grace_ms = Integer(ENV.fetch("HOST_GRACE_MS", 3 * 60 * 1000))
  # how many games may be open at once, since each one holds memory until it closes
  c.max_rooms = Integer(ENV.fetch("MAX_ROOMS", 200))
end

# Optional extra blocked nicknames, one per line. A missing file is fine.
Rails.application.config.after_initialize do
  Tigerquiz::Nicknames.load_extra_words(Rails.application.config.tigerquiz.quiz_dir.join("blocked-words.txt"))
end

