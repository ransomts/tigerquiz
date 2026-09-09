# Everything the reports page shows about a finished game, and the review quiz
# it can spin off. A port of the report half of lib/db.js plus the report
# routes in server.js; key names are kept so the page reads them unchanged.
class GameReport
  NEEDS_REVIEW_BELOW = 0.5
  CSV_HEAD = %w[player identifier rank total_score question type question_text correct_answer response correct points seconds].freeze

  Q = Tigerquiz::Questions

  attr_reader :game

  def self.listing(user)
    user.games.finished.newest_first.limit(100).map(&:listing)
  end

  def initialize(game)
    @game = game
  end

  def to_h
    questions = game.game_questions.order(:idx).to_a
    players = game.game_players.order(Arel.sql("rank IS NULL, rank, score DESC")).to_a
    answers = game.game_answers.to_a
    by_question = answers.group_by(&:idx)
    by_player = answers.group_by(&:player)

    question_stats = questions.map do |q|
      rows = by_question[q.idx] || []
      scored = rows.reject { |r| r.correct.nil? }
      right = scored.count(&:correct)
      distractors = breakdown(q.question_type, q.choices, q.correct_answer, rows)
      {
        "idx" => q.idx,
        "sourceIdx" => q.source_idx,
        "type" => q.question_type,
        "text" => q.text,
        "answer" => q.answer,
        "explanation" => q.explanation,
        "choices" => q.choices,
        "responses" => rows.length,
        "scored" => scored.length,
        "correct" => right,
        # nil for polls and word clouds, which have no right answer
        "correctRate" => scored.empty? ? nil : right.fdiv(scored.length),
        "avgMs" => rows.empty? ? nil : rows.sum { |r| r.ms || 0 }.fdiv(rows.length).round,
        "distractors" => distractors,
        # the wrong answer the class landed on, which names the misconception.
        # one lone pick is not a pattern, so it takes at least two to be called out
        "topDistractor" => distractors.find { |d| d["correct"] == false && d["n"] >= 2 }
      }
    end

    player_stats = players.map do |p|
      rows = (by_player[p.name] || []).sort_by(&:idx)
      scored = rows.reject { |r| r.correct.nil? }
      {
        "name" => p.name,
        "identifier" => p.identifier,
        "score" => p.score,
        "rank" => p.rank,
        "answered" => rows.length,
        "correct" => scored.count(&:correct),
        "scored" => scored.length,
        "answers" => rows.map { |r| { "idx" => r.idx, "response" => r.response, "correct" => r.correct, "points" => r.points, "ms" => r.ms } }
      }
    end

    # questions most students got wrong, worst first
    needs_review = question_stats
      .select { |q| q["correctRate"] && q["scored"] > 0 && q["correctRate"] < NEEDS_REVIEW_BELOW }
      .each_with_index.sort_by { |q, i| [q["correctRate"], i] }.map(&:first)

    report = { "game" => game.listing, "questions" => question_stats, "players" => player_stats, "needsReview" => needs_review }
    with_roster(report)
  end

  # Add absentees when the game was played against a class list.
  def with_roster(report)
    roster = game.roster&.playable
    return report unless roster

    # players are stored under their canonical roster name, but match on id too
    # in case the list was edited between the game and the report
    played = report["players"].map { |p| Q.norm_text(p["identifier"].presence || p["name"]) }.to_set
    did_play = ->(s) { played.include?(Q.norm_text(s["name"])) || (s["id"] && played.include?(Q.norm_text(s["id"]))) }
    report["roster"] = {
      "title" => roster["title"],
      "total" => roster["students"].length,
      "absent" => roster["students"].reject { |s| did_play.call(s) }.map { |s| s["name"] }
    }
    report
  end

  def csv_name
    "#{game.title.gsub(/[^A-Za-z0-9_-]+/, "_")}_#{game.started_at.utc.strftime("%Y-%m-%d")}.csv"
  end

  def to_csv(report = to_h)
    lines = [CSV_HEAD.join(",")]
    by_idx = report["questions"].index_by { |q| q["idx"] }
    report["players"].each do |p|
      p["answers"].each do |a|
        q = by_idx[a["idx"]] || {}
        lines << [
          p["name"], p["identifier"], p["rank"], p["score"],
          a["idx"] + 1, q["type"], q["text"], q["answer"],
          format_response(a["response"]), a["correct"].nil? ? "" : (a["correct"] ? "yes" : "no"),
          a["points"], a["ms"].nil? ? "" : format("%.1f", a["ms"] / 1000.0)
        ].map { |v| csv_cell(v) }.join(",")
      end
    end
    lines.join("\n") + "\n"
  end

  # Build a new quiz from the questions the class got wrong, for spaced review in
  # a later lesson. Questions are looked up in the original quiz by the source
  # index recorded at play time, so shuffling does not confuse the mapping.
  # Returns the new Quiz, or raises ReviewError with a message for the page.
  class ReviewError < StandardError; end

  def review_quiz(threshold: 0.6)
    threshold = threshold.is_a?(Numeric) ? threshold.clamp(0.05, 1) : 1
    source_quiz = game.quiz || game.user.quizzes.find_by(slug: game.quiz_slug)
    raise ReviewError, "The original quiz no longer exists" unless source_quiz

    source = source_quiz.playable
    report = to_h
    missed = report["questions"]
      .select { |q| q["correctRate"] && q["correctRate"] < threshold && !q["sourceIdx"].nil? }
      .each_with_index.sort_by { |q, i| [q["correctRate"], i] }.map(&:first)
    raise ReviewError, "Nothing was missed often enough to review" if missed.empty?

    picked = missed.map { |q| q["sourceIdx"] }.uniq.filter_map { |i| source["questions"][i] }.map { |q| Tigerquiz::QuizDocument.strip_internals(q) }
    raise ReviewError, "The original quiz no longer has those questions" if picked.empty?

    game.user.quizzes.create!(
      slug: Quiz.unique_slug(game.user, "review-#{game.quiz_slug}"),
      body: {
        "title" => "Review: #{source["title"]}",
        "note" => "Questions the class missed on #{game.started_at.utc.strftime("%Y-%m-%d")}",
        "shuffleQuestions" => true,
        "shuffleAnswers" => source["shuffleAnswers"] == true,
        "questions" => picked
      }
    )
  end

  # Everyone who has ever played one of this instructor's games, keyed by the
  # identifier when there is one and the nickname otherwise, so a student can be
  # followed across sessions.
  def self.students(user)
    # Player rows only. Summing the answers table here meant reading every answer
    # of every game ever played, which grows with the years while this list does not.
    rows = GamePlayer.joins(:game).where(games: { user_id: user.id }).where.not(games: { ended_at: nil })
      .order("games.started_at DESC").includes(:game).to_a

    by_who = {}
    rows.each do |p|
      who = p.identifier.presence || p.name
      correct, scored = p.correct, p.scored
      entry = by_who[who] ||= { "who" => who, "nicknames" => [], "games" => [], "correct" => 0, "scored" => 0 }
      entry["nicknames"] << p.name unless entry["nicknames"].include?(p.name)
      entry["games"] << {
        "gameId" => p.game_id, "title" => p.game.title, "startedAt" => p.game.listing["started_at"],
        "score" => p.score, "rank" => p.rank, "correct" => correct, "scored" => scored
      }
      entry["correct"] += correct
      entry["scored"] += scored
    end
    by_who.values.map do |e|
      e.merge(
        "gamesPlayed" => e["games"].length,
        "correctRate" => e["scored"] > 0 ? e["correct"].fdiv(e["scored"]) : nil,
        "lastPlayed" => e["games"].map { |g| g["startedAt"] }.max
      )
    end.sort_by { |e| [e["who"].downcase, e["who"]] }
  end

  private

  # Count what people actually chose, so a report can name the wrong answer the
  # class landed on rather than only how many missed it. Sorted most-picked first.
  def breakdown(type, choices, correct_answer, rows)
    responses = rows.reject { |r| r.response.nil? }.map(&:response)
    return [] if responses.empty?

    if choices && %w[choice truefalse poll multi].include?(type)
      right = ->(i) { correct_answer.is_a?(Array) ? correct_answer.include?(i) : correct_answer == i }
      counts = Array.new(choices.length, 0)
      responses.each { |r| Array(r).each { |i| counts[i] += 1 if i.is_a?(Integer) && i >= 0 && i < counts.length } }
      return choices.each_with_index
        .map { |label, i| { "label" => label, "n" => counts[i], "correct" => correct_answer.nil? ? nil : right.call(i) } }
        .select { |d| d["n"] > 0 }
        .each_with_index.sort_by { |d, i| [-d["n"], i] }.map(&:first)
    end

    if %w[text wordcloud].include?(type)
      freq = {}
      responses.each do |r|
        Array(r).each do |w|
          label = Q.js_str(w).strip
          key = label.downcase
          next if key.empty?

          cur = freq[key] ||= { "label" => label, "n" => 0, "correct" => nil }
          cur["n"] += 1
        end
      end
      # mark which typed answers were accepted, using the graded rows
      right_text = rows.select { |r| r.correct == true && !r.response.nil? }.map { |r| Q.js_str(r.response).strip.downcase }.to_set
      return freq.map { |key, v| v.merge("correct" => right_text.empty? ? nil : right_text.include?(key)) }
        .each_with_index.sort_by { |d, i| [-d["n"], i] }.map(&:first)
    end

    if type == "slider"
      freq = Hash.new(0)
      responses.each { |v| freq[v] += 1 }
      return freq.map { |value, n| { "label" => Q.js_str(value), "n" => n, "correct" => correct_answer == value } }
        .each_with_index.sort_by { |d, i| [-d["n"], i] }.map(&:first).first(10)
    end

    []
  end

  def format_response(r)
    case r
    when Array then r.join(" | ")
    when nil then ""
    else Q.js_str(r)
    end
  end

  def csv_cell(v)
    s = v.nil? ? "" : Q.js_str(v)
    s.match?(/[",\n]/) ? "\"#{s.gsub('"', '""')}\"" : s
  end
end
