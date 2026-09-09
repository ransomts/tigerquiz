require "test_helper"

class QuizImportTest < ActiveSupport::TestCase
  setup { @user = User.create!(eppn: "ada@example.edu") }

  test "imports the sample quizzes and class lists once" do
    result = QuizImport.new(@user, dir: Rails.root.join("quizzes")).run
    assert_equal 3, result.quizzes
    assert_equal 1, result.rosters
    assert_equal 0, result.invalid
    assert_equal %w[all-types features-demo sample], @user.quizzes.order(:slug).pluck(:slug)
    assert_equal 9, @user.quizzes.find_by(slug: "all-types").playable["questions"].length
    assert_equal "Period 3 Biology", @user.rosters.find_by(slug: "period3").title

    again = QuizImport.new(@user, dir: Rails.root.join("quizzes")).run
    assert_equal 0, again.quizzes + again.rosters
    assert_equal 4, again.skipped
  end

  test "invalid files are reported and skipped" do
    result = QuizImport.new(@user, dir: Rails.root.join("test/fixtures/bad-quizzes")).run
    assert_equal 0, result.quizzes, "every sample there is broken somehow"
    assert_operator result.invalid, :>=, 3
    assert_equal 2, result.rosters, "dupes.json and plain.json load; the empty one does not"
  end

  test "the import rake task uses the named user" do
    Rails.application.load_tasks unless Rake::Task.task_defined?("quizzes:import")
    silence_stream($stdout) { Rake::Task["quizzes:import"].invoke("grace@example.edu") }
    assert_equal 3, User.find_by!(eppn: "grace@example.edu").quizzes.count
  end

  private

  def silence_stream(stream)
    old = stream.dup
    stream.reopen(File::NULL)
    yield
  ensure
    stream.reopen(old)
  end
end
