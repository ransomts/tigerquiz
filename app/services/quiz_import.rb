# Load quizzes/*.json and quizzes/rosters/*.json into the database for one user,
# so files written for the Node version, or by hand, become editable quizzes.
class QuizImport
  Result = Struct.new(:quizzes, :rosters, :skipped, :invalid, keyword_init: true)

  def initialize(user, dir:, out: nil)
    @user = user
    @dir = Pathname.new(dir)
    @out = out
  end

  # Existing slugs are left alone unless force is set, in which case the file wins.
  def run(force: false)
    result = Result.new(quizzes: 0, rosters: 0, skipped: 0, invalid: 0)
    json_files(@dir).each do |file|
      slug = File.basename(file, ".json")
      import(@user.quizzes, slug, file, force, result) do |raw|
        { "body" => Tigerquiz::QuizDocument.pick_fields(raw) }
      end
    end
    json_files(@dir.join("rosters")).each do |file|
      slug = File.basename(file, ".json")
      import(@user.rosters, slug, file, force, result) do |raw|
        doc = Tigerquiz::RosterDocument.load(raw, slug)
        { "title" => doc["title"], "students" => Tigerquiz::RosterDocument.clean_students(doc["students"]) }
      end
    end
    say "Imported #{result.quizzes} quizzes and #{result.rosters} class lists for #{@user.eppn}" \
        "#{result.skipped > 0 ? ", skipped #{result.skipped} already present" : ""}" \
        "#{result.invalid > 0 ? ", #{result.invalid} invalid" : ""}"
    result
  end

  private

  def json_files(dir)
    Dir.children(dir).select { |f| f.end_with?(".json") }.sort.map { |f| dir.join(f) }
  rescue SystemCallError
    []
  end

  def import(scope, slug, file, force, result)
    existing = scope.find_by(slug: slug)
    if existing && !force
      result.skipped += 1
      return
    end
    raw = JSON.parse(File.read(file))
    attrs = yield(raw)
    record = existing || scope.build(slug: slug)
    record.assign_attributes(attrs)
    record.save!
    record.is_a?(Quiz) ? result.quizzes += 1 : result.rosters += 1
    say "  #{existing ? "updated" : "added"} #{record.class.name.downcase} #{slug}"
  rescue JSON::ParserError, ActiveRecord::RecordInvalid, Tigerquiz::InvalidQuestion => e
    result.invalid += 1
    say "  skipped #{slug}: #{e.message.lines.first.strip}"
  end

  def say(msg)
    @out&.puts(msg)
  end
end
