# frozen_string_literal: true

# Helper for the tests of the pure logic under lib/tigerquiz. These tests do not
# need Rails, so they can run with plain Ruby:
#
#   ruby -Ilib test/lib/parity_test.rb
#   bin/test-lib                       # all of them
$LOAD_PATH.unshift File.expand_path("../../lib", __dir__)

require "minitest/autorun"
require "json"
require "tmpdir"
require "tigerquiz/questions"
require "tigerquiz/nicknames"
require "tigerquiz/quiz_check"

FIXTURES = File.expand_path("../fixtures", __dir__)
PROJECT_ROOT = File.expand_path("../..", __dir__)
