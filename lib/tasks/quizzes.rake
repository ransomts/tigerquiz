# frozen_string_literal: true

namespace :quizzes do
  desc "Validate every quiz and class list, or one: rails 'quizzes:check[my-quiz]'"
  task :check, [:quiz] do |_t, args|
    require "tigerquiz/quiz_check"
    root = defined?(Rails) ? Rails.root.to_s : File.expand_path("../..", __dir__)
    exit Tigerquiz::QuizCheck.new(root: root).run([args[:quiz], *args.extras].compact)
  end
end
