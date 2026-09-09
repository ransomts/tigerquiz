# In development, the sample quizzes are imported for the developer user so the
# host page has something to play. In production, use bin/rails quizzes:import.
if Rails.env.development?
  user = User.find_or_create_by!(eppn: Rails.application.config.tigerquiz.dev_user)
  QuizImport.new(user, dir: Rails.application.config.tigerquiz.quiz_dir, out: $stdout).run
end
