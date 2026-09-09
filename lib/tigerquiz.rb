# frozen_string_literal: true

# Pure game logic shared by the web app, the rake tasks and the tests.
# Nothing under lib/tigerquiz touches Rails, the database or the network, so it
# can be loaded with plain Ruby (see bin/check and bin/test-lib). Under Rails the
# same files are autoloaded into the application's namespace.
module Tigerquiz
end
