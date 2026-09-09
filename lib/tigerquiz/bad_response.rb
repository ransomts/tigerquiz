# frozen_string_literal: true

require_relative "../tigerquiz"

module Tigerquiz
  # A player's response that cannot be graded. The message is shown to the player.
  class BadResponse < StandardError; end
end
