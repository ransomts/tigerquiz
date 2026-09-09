# frozen_string_literal: true

require_relative "../tigerquiz"

module Tigerquiz
  # A quiz question that cannot be played. The message names the question.
  class InvalidQuestion < StandardError; end
end
