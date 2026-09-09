# frozen_string_literal: true

require_relative "questions"

module Tigerquiz
  # The quiz document: the JSON shape the editor writes, the files use and a
  # game is built from. Validation, cleaning and the per-game preparation that
  # server.js did around loadQuiz and prepareQuiz.
  module QuizDocument
    QUIZ_FIELDS = %w[title note identifier shuffleQuestions shuffleAnswers phoneText].freeze
    QUESTION_FIELDS = %w[
      type text image time explanation discuss
      choices answer answers accept fuzzy
      min max step tolerance unit items maxWords
    ].freeze
    ID = /\A[A-Za-z0-9_-]+\z/

    module_function

    # Validate a quiz body the way a game would, and report every problem at once.
    # Returns { "problems" => [...], "questions" => [normalised...] or nil }.
    def validate(body)
      problems = []
      return { "problems" => ["Not an object"], "questions" => nil } unless body.is_a?(Hash)

      problems << "Give the quiz a title" if body["title"].to_s.strip.empty?
      questions = body["questions"]
      unless questions.is_a?(Array) && !questions.empty?
        problems << "Add at least one question"
        return { "problems" => problems, "questions" => nil }
      end
      normalised = []
      questions.each_with_index do |q, i|
        normalised << Questions.normalize_question(q, i)
      rescue InvalidQuestion => e
        problems << e.message
      end
      { "problems" => problems, "questions" => normalised }
    end

    # Only known fields survive, so a stray key cannot end up in the document.
    def pick_fields(body)
      out = {}
      QUIZ_FIELDS.each do |k|
        v = body[k]
        out[k] = v unless v.nil? || v == ""
      end
      out["questions"] = Array(body["questions"]).map do |q|
        cleaned = {}
        q = q.is_a?(Hash) ? q : {}
        QUESTION_FIELDS.each do |k|
          v = q[k]
          next if v.nil? || v == ""
          next if v.is_a?(Array) && v.empty?

          cleaned[k] = v
        end
        cleaned
      end
      out
    end

    # The normalised quiz a game plays, from a document. Raises InvalidQuestion.
    def load(doc, id)
      raise InvalidQuestion, "bad quiz id" unless id.to_s.match?(ID)

      questions = doc["questions"]
      raise InvalidQuestion, "quiz has no questions" unless questions.is_a?(Array) && !questions.empty?

      identifier = doc["identifier"]
      {
        "id" => id.to_s,
        "title" => Questions.js_str(doc["title"].to_s.empty? ? id : doc["title"]),
        # ask each player for a real name or student id alongside their nickname
        "identifier" => identifier.is_a?(String) && !identifier.strip.empty? ? identifier.strip[0, 40] : nil,
        # mirror the question and choices onto phones unless the quiz opts out
        "phoneText" => doc["phoneText"] != false,
        "shuffleQuestions" => doc["shuffleQuestions"] == true,
        "shuffleAnswers" => doc["shuffleAnswers"] == true,
        "questions" => questions.each_with_index.map { |q, i| Questions.normalize_question(q, i) }
      }
    end

    # A copy of the quiz with order randomised per the quiz's own flags.
    # sourceIndex is set during normalisation and survives shuffling, so a review
    # quiz built from a report can find the original question again.
    def prepare(quiz, random: Random)
      questions = quiz["questions"]
      questions = Questions.shuffled(questions, random: random) if quiz["shuffleQuestions"]
      if quiz["shuffleAnswers"]
        questions = questions.map do |q|
          # true/false keeps True first; the other types have no fixed order to protect
          next q unless %w[choice multi poll].include?(q["type"])

          order = Questions.shuffled((0...q["choices"].length).to_a, random: random)
          moved = q.merge("choices" => order.map { |i| q["choices"][i] })
          moved["answer"] = order.index(q["answer"]) if q["type"] == "choice"
          moved["answers"] = q["answers"].map { |a| order.index(a) }.sort if q["type"] == "multi"
          moved
        end
      end
      quiz.merge("questions" => questions)
    end

    # Drop the fields normalisation added, so a written question reads like a hand-made one.
    def strip_internals(q)
      out = q.dup
      %w[sourceIndex phoneText].each { |k| out.delete(k) }
      out.delete("explanation") if out["explanation"].nil?
      out.delete("discuss") if out["discuss"] == false
      out.delete("type") if out["type"] == "choice"
      # images were rewritten to a URL path; put the bare filename back
      if out["image"].is_a?(String) && out["image"].start_with?("/quiz-images/")
        out["image"] = decode_uri_component(out["image"].delete_prefix("/quiz-images/"))
      end
      out
    end

    # A slug nobody has yet: the base, else base-2, base-3 and so on.
    def unique_slug(base)
      safe = base.gsub(/[^A-Za-z0-9_-]+/, "-")[0, 40].gsub(/\A-+|-+\z/, "")
      safe = "quiz" if safe.empty?
      id = safe
      n = 2
      while yield(id)
        id = "#{safe}-#{n}"
        n += 1
      end
      id
    end

    def decode_uri_component(s)
      s.gsub(/(?:%[0-9A-Fa-f]{2})+/) { |m| m.scan(/%([0-9A-Fa-f]{2})/).flatten.map { |h| h.to_i(16) }.pack("C*").force_encoding("UTF-8") }
    end
  end
end
