# frozen_string_literal: true

namespace :quizzes do
  desc "Validate every quiz file and class list, or one: rails 'quizzes:check[my-quiz]'"
  task :check, [:quiz] do |_t, args|
    require "tigerquiz/quiz_check"
    root = defined?(Rails) ? Rails.root.to_s : File.expand_path("../..", __dir__)
    exit Tigerquiz::QuizCheck.new(root: root).run([args[:quiz], *args.extras].compact)
  end

  desc "Import quizzes/*.json and quizzes/rosters/*.json for a user: rails 'quizzes:import[user@example.edu]' (FORCE=1 overwrites)"
  task :import, [:eppn] => :environment do |_t, args|
    eppn = args[:eppn].presence || Rails.application.config.tigerquiz.dev_user
    user = User.find_or_create_by!(eppn: eppn)
    QuizImport.new(user, dir: Rails.application.config.tigerquiz.quiz_dir, out: $stdout).run(force: ENV["FORCE"] == "1")
  end

  desc "Import past game reports from a Node tigerquiz database: rails 'quizzes:import_reports[user@example.edu,/srv/tigerquiz/data/tigerquiz.db]'"
  task :import_reports, [ :eppn, :db ] => :environment do |_t, args|
    eppn = args[:eppn].presence || Rails.application.config.tigerquiz.dev_user
    path = args[:db].presence or abort "Which database? rails 'quizzes:import_reports[you@example.edu,path/to/tigerquiz.db]'"
    user = User.find_or_create_by!(eppn: eppn)
    ReportsImport.new(user, path: path, out: $stdout).run
  end
end
