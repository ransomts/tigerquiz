# frozen_string_literal: true

require "json"
require "pathname"
require_relative "questions"

module Tigerquiz
  # Validate every quiz and class list, and warn about things that are legal but
  # probably mistakes. Run it before a lesson so a broken file fails here rather
  # than in front of a class.
  #
  #   bin/check                    all quizzes and rosters
  #   bin/check my-quiz            just one, by id or path
  #   bin/rails quizzes:check      the same, once the Rails app exists
  class QuizCheck
    QUIZ_FIELDS = %w[title note questions identifier shuffleQuestions shuffleAnswers phoneText].freeze
    COLORS = { red: "\e[31m", yellow: "\e[33m", green: "\e[32m", dim: "\e[2m", bold: "\e[1m", off: "\e[0m" }.freeze
    PLAIN = COLORS.transform_values { "" }.freeze

    attr_reader :errors, :warnings

    def initialize(root:, quiz_dir: File.join(root, "quizzes"), out: $stdout, color: out.respond_to?(:tty?) && out.tty?)
      @root = Pathname.new(File.expand_path(root))
      @quiz_dir = File.expand_path(quiz_dir)
      @image_dir = File.join(@quiz_dir, "images")
      @roster_dir = File.join(@quiz_dir, "rosters")
      @out = out
      @c = color ? COLORS : PLAIN
      @errors = 0
      @warnings = 0
    end

    # Check the named quizzes, or everything when given none. Returns an exit status.
    def run(wanted = [])
      files = pick_files(wanted)
      if files.empty?
        @out.puts "No quiz files found in quizzes/"
        return 1
      end
      files.each { |f| check_quiz(f) }
      check_rosters if wanted.empty?

      @out.puts ""
      if @errors > 0
        @out.puts "#{@c[:red]}#{@c[:bold]}#{@errors} error#{@errors > 1 ? "s" : ""}#{@c[:off]}, #{@warnings} warning#{@warnings == 1 ? "" : "s"}"
      elsif @warnings > 0
        @out.puts "#{@c[:yellow]}No errors, #{@warnings} warning#{@warnings == 1 ? "" : "s"}#{@c[:off]}"
      else
        @out.puts "#{@c[:green]}All good#{@c[:off]}"
      end
      @errors > 0 ? 1 : 0
    end

    private

    def err(msg)
      @errors += 1
      @out.puts "  #{@c[:red]}error#{@c[:off]}   #{msg}"
    end

    def warn(msg)
      @warnings += 1
      @out.puts "  #{@c[:yellow]}warning#{@c[:off]} #{msg}"
    end

    def relative(file)
      Pathname.new(file).relative_path_from(@root).to_s
    end

    def pick_files(wanted)
      return wanted.map { |w| w.end_with?(".json") ? File.expand_path(w) : File.join(@quiz_dir, "#{w}.json") } unless wanted.empty?

      Dir.children(@quiz_dir).select { |f| f.end_with?(".json") }.sort.map { |f| File.join(@quiz_dir, f) }
    rescue SystemCallError
      []
    end

    def check_quiz(file)
      @out.puts "\n#{@c[:bold]}#{relative(file)}#{@c[:off]}"

      begin
        raw = JSON.parse(File.read(file))
      rescue Errno::ENOENT
        return err("file not found")
      rescue JSON::ParserError => e
        return err("not valid JSON: #{e.message.gsub(/\s+/, " ").strip}")
      end

      id = File.basename(file, ".json")
      err(%(filename "#{id}" must be letters, digits, dash or underscore only)) unless id.match?(/\A[A-Za-z0-9_-]+\z/)
      raw = {} unless raw.is_a?(Hash)
      warn("no title, the filename will be used instead") if falsy?(raw["title"])
      questions = raw["questions"]
      return err("no questions array") unless questions.is_a?(Array) && !questions.empty?

      raw.each_key do |key|
        warn(%(unknown quiz field "#{key}", it will be ignored)) unless QUIZ_FIELDS.include?(key)
      end

      seen = {}
      ok = 0
      questions.each_with_index do |raw_q, i|
        begin
          q = Questions.normalize_question(raw_q, i)
        rescue InvalidQuestion => e
          err(e.message)
          next
        end
        ok += 1
        at = "question #{i + 1}"

        type = raw_q["type"]
        warn(%(#{at}: unknown type "#{type}", treated as choice)) if !falsy?(type) && !Questions::TYPES.include?(type)

        # a duplicated question stem is usually a copy-paste that was never edited
        key = Questions.norm_text(q["text"])
        if !key.empty? && seen.key?(key)
          warn("#{at}: same text as question #{seen[key] + 1}")
        elsif !key.empty?
          seen[key] = i
        end

        if q["choices"]
          norm = q["choices"].map { |c| Questions.norm_text(c) }
          dupes = norm.select.with_index { |c, j| !c.empty? && norm.index(c) != j }
          err("#{at}: duplicate choices (#{dupes.uniq.join(", ")})") unless dupes.empty?
          err("#{at}: a choice is empty") if q["choices"].any? { |c| c.strip.empty? }
          longest = q["choices"].map(&:length).max
          warn("#{at}: a choice is #{longest} characters, it may not fit on screen") if longest > 75
        end

        warn("#{at}: only #{q["time"]}s to answer") if q["time"] > 0 && q["time"] < 5 && q["type"] != "slide"
        warn("#{at}: #{q["time"]}s is a very long timer") if q["time"] > 300
        warn("#{at}: question text is #{q["text"].length} characters, it may not fit on screen") if q["text"].length > 160

        if q["type"] == "text"
          warn("#{at}: a long accepted answer is hard to type exactly") if q["accept"].any? { |a| a.length > 40 }
          warn("#{at}: only one accepted spelling, consider listing alternatives") if q["accept"].length == 1
        end
        if q["type"] == "slider"
          err("#{at}: answer #{q["answer"]} is outside #{q["min"]}-#{q["max"]}") if q["answer"] < q["min"] || q["answer"] > q["max"]
          steps = (q["max"] - q["min"]).fdiv(q["step"])
          warn("#{at}: #{steps.round} steps is hard to hit on a phone") if steps > 1000
          warn("#{at}: no tolerance set, defaulting to 5% of the range") if q["tolerance"].zero?
        end
        warn("#{at}: every choice is correct") if q["type"] == "multi" && q["answers"].length == q["choices"].length
        warn("#{at}: slide has neither text nor an image") if q["type"] == "slide" && q["text"].empty? && q["image"].nil?
        # an explanation is what turns a wrong answer into something learned
        if q["explanation"].nil? && !%w[slide poll wordcloud].include?(q["type"])
          warn("#{at}: no explanation, students will not learn why they were wrong")
        end
        if q["explanation"] && q["explanation"].length > 300
          warn("#{at}: explanation is #{q["explanation"].length} characters, it may not fit")
        end
        if q["discuss"] && !%w[choice truefalse multi].include?(q["type"])
          warn("#{at}: discuss only affects choice-style questions")
        end

        # images are referenced by name, so a typo only shows up at game time
        if q["image"]&.start_with?("/quiz-images/")
          file_name = decode_uri_component(q["image"].delete_prefix("/quiz-images/"))
          err(%(#{at}: image "#{file_name}" not found in quizzes/images/)) unless File.exist?(File.join(@image_dir, file_name))
        end
      end

      counts = Hash.new(0)
      questions.each do |raw_q|
        t = raw_q.is_a?(Hash) ? raw_q["type"] : nil
        counts[falsy?(t) ? "choice" : t] += 1
      end
      shape = counts.map { |t, n| "#{n} #{t}" }.join(", ")
      @out.puts "  #{@c[:dim]}#{ok}/#{questions.length} questions valid · #{shape}#{@c[:off]}"
    end

    def check_rosters
      files = Dir.children(@roster_dir).select { |f| f.end_with?(".json") }.sort
      files.each do |f|
        path = File.join(@roster_dir, f)
        @out.puts "\n#{@c[:bold]}#{relative(path)}#{@c[:off]}"
        begin
          raw = JSON.parse(File.read(path))
        rescue JSON::ParserError => e
          err("not valid JSON: #{e.message.gsub(/\s+/, " ").strip}")
          next
        end
        list = raw.is_a?(Array) ? raw : (raw.is_a?(Hash) ? raw["students"] : nil)
        unless list.is_a?(Array) && !list.empty?
          err("no students")
          next
        end
        names = {}
        ids = {}
        list.each_with_index do |s, i|
          student = s.is_a?(String) ? { "name" => s } : (s.is_a?(Hash) ? s : nil)
          name = student && student["name"]
          if falsy?(name) || Questions.js_str(name).strip.empty?
            err("student #{i + 1} has no name")
            next
          end
          # players are matched on a normalised name, so two students who normalise
          # the same would be indistinguishable at the join screen
          nk = Questions.norm_text(name)
          if names.key?(nk)
            err(%("#{name}" cannot be told apart from "#{names[nk]}"))
          else
            names[nk] = name
          end
          next if student["id"].nil?

          ik = Questions.norm_text(Questions.js_str(student["id"]))
          if ids.key?(ik)
            err(%(id "#{student["id"]}" is used by both #{ids[ik]} and #{name}))
          else
            ids[ik] = name
          end
        end
        with_ids = list.count { |s| s.is_a?(Hash) && !s["id"].nil? }
        warn("#{list.length - with_ids} of #{list.length} students have no id") if with_ids > 0 && with_ids < list.length
        @out.puts "  #{@c[:dim]}#{list.length} students#{@c[:off]}"
      end
    rescue SystemCallError
      nil
    end

    # JavaScript falsiness, for fields the format has always tested that way.
    def falsy?(v)
      v.nil? || v == false || v == "" || v == 0
    end

    def decode_uri_component(s)
      s.gsub(/(?:%[0-9A-Fa-f]{2})+/) { |m| m.scan(/%([0-9A-Fa-f]{2})/).flatten.map { |h| h.to_i(16) }.pack("C*").force_encoding("UTF-8") }
    end
  end
end
