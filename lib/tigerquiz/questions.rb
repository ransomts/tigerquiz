# frozen_string_literal: true

require_relative "invalid_question"
require_relative "bad_response"

module Tigerquiz
  # Question type definitions: validation, presentation and grading.
  #
  # Every question is normalised to one internal shape by normalize_question,
  # then graded by grade. Questions are plain hashes with string keys, in the
  # same camelCase shape as the quiz files and the browser code, so a quiz can
  # go from JSON to the editor to a game and back without translation.
  #
  # This is a line-for-line port of lib/questions.js from the Node version.
  # test/fixtures/parity.json records what that code does and
  # test/lib/parity_test.rb checks this file against it.
  module Questions
    TYPES = %w[choice truefalse multi poll slider text wordcloud order slide].freeze

    # Types that do not produce a score: no points, no streak effect, no correct answer.
    UNSCORED = %w[poll wordcloud slide].freeze
    # Types nobody answers at all.
    NO_ANSWER = %w[slide].freeze

    MAX_POINTS = 1000

    module_function

    def unscored?(type) = UNSCORED.include?(type)
    def answerable?(type) = !NO_ANSWER.include?(type)

    # Points for a fully correct answer given how fast it arrived.
    def speed_points(ms, time_ms)
      frac = [[ms, 0].max.fdiv([time_ms, 1].max), 1].min
      (MAX_POINTS * (1 - frac / 2.0)).round
    end

    # ---------- text matching ----------

    def norm_text(s)
      js_str(s.nil? ? "" : s)
        .downcase
        .unicode_normalize(:nfkd)
        .gsub(/[\u0300-\u036f]/, "") # combining accents
        .gsub(/[^\p{L}\p{N}[:space:]]/, "")
        .gsub(/[[:space:]]+/, " ")
        .strip
    end

    def levenshtein(a, b)
      return 0 if a == b
      return b.length if a.empty?
      return a.length if b.empty?

      a = a.chars
      b = b.chars
      prev = (0..b.length).to_a
      a.each_with_index do |ca, i|
        row = [i + 1]
        b.each_with_index do |cb, j|
          row[j + 1] = [prev[j + 1] + 1, row[j] + 1, prev[j] + (ca == cb ? 0 : 1)].min
        end
        prev = row
      end
      prev[b.length]
    end

    # How many typos to forgive in a word of this length.
    def fuzz_tolerance(s)
      return 0 if s.length <= 4
      return 1 if s.length <= 8

      2
    end

    # ---------- JavaScript coercions ----------
    # The quiz format grew up under JavaScript's loose conversions, and files in
    # the wild rely on them ("time": "15", "answer": "true"). These reproduce
    # the ones the format depends on.

    # JavaScript's String(): nil becomes "null", whole floats drop their ".0".
    def js_str(v)
      case v
      when nil then "null"
      when Float then v.finite? && v == v.floor && v.abs < 1e21 ? v.to_i.to_s : v.to_s
      when Array then v.map { |x| x.nil? ? "" : js_str(x) }.join(",")
      when Hash then "[object Object]"
      else v.to_s
      end
    end

    # JavaScript's Number(), with nil standing in for NaN. Whole floats become integers.
    def js_num(v)
      case v
      when Integer then v
      when Float then intify(v)
      when true then 1
      when false, nil then 0
      when String
        s = v.strip
        return 0 if s.empty?
        return nil if s.include?("_")

        begin
          Integer(s, 10)
        rescue ArgumentError
          begin
            intify(Float(s))
          rescue ArgumentError
            nil
          end
        end
      when Array then v.empty? ? 0 : (v.size == 1 ? js_num(v[0]) : nil)
      end
    end

    def intify(f)
      return nil if f.nan?
      return f unless f.finite?

      f == f.floor && f.abs < 2**53 ? f.to_i : f
    end

    # Number.isInteger(v) ? v : nil
    def as_index(v)
      case v
      when Integer then v
      when Float then v.finite? && v == v.floor ? v.to_i : nil
      end
    end

    def as_array(v)
      case v
      when Array then v
      when nil then []
      else [v]
      end
    end

    # encodeURIComponent
    def encode_uri_component(s)
      s.gsub(/[^A-Za-z0-9\-_.!~*'()]/) { |c| c.bytes.map { |b| format("%%%02X", b) }.join }
    end

    # ---------- normalisation ----------

    def normalize_question(raw, i)
      where = "question #{i + 1}"
      # an array is an object to JavaScript, and spreads into one keyed by position
      raw = raw.each_with_index.to_h { |v, i| [i.to_s, v] } if raw.is_a?(Array)
      raise InvalidQuestion, "#{where}: not an object" unless raw.is_a?(Hash)

      q = raw.transform_keys(&:to_s)
      q["type"] = TYPES.include?(q["type"]) ? q["type"] : "choice"
      q["text"] = js_str(q["text"].nil? ? "" : q["text"]).strip
      raise InvalidQuestion, "#{where}: needs text" if q["text"].empty? && q["type"] != "slide"

      time = js_num(q["time"])
      q["time"] = time && time > 0 ? time : 20
      q["time"] = 0 if q["type"] == "slide"

      # shown to everyone once the answer is revealed, so a wrong answer teaches something
      explanation = q["explanation"]
      q["explanation"] = explanation.is_a?(String) && !explanation.strip.empty? ? explanation.strip : nil
      # suggests a peer-instruction round: answer, discuss, answer again
      q["discuss"] = q["discuss"] == true
      # position in the quiz file, kept through shuffling so reviews can find it again
      q["sourceIndex"] = i

      # image: a filename under quizzes/images/, or an absolute http(s) URL
      image = q["image"]
      if image.is_a?(String) && !image.strip.empty?
        img = image.strip
        q["image"] = img.match?(%r{\Ahttps?://}) ? img : "/quiz-images/#{encode_uri_component(img.sub(%r{\A.*[\\/]}, ""))}"
      else
        q.delete("image")
      end

      case q["type"]
      when "truefalse"
        q["choices"] = %w[True False]
        a = q["answer"]
        a = a.strip.downcase == "true" if a.is_a?(String)
        a = a ? 0 : 1 if a == true || a == false
        q["answer"] = require_index(a, 2, where)
      when "choice"
        require_choices(q, where)
        q["answer"] = require_index(q["answer"], q["choices"].length, where)
      when "poll"
        require_choices(q, where)
        q.delete("answer")
      when "multi"
        require_choices(q, where)
        answers = as_array(q["answers"].nil? ? q["answer"] : q["answers"]).map { |a| js_num(a) }.uniq
        raise InvalidQuestion, "#{where}: multi needs at least one correct answer" if answers.empty?
        raise InvalidQuestion, "#{where}: answer must be an index into choices" if answers.any?(&:nil?)

        q["answers"] = answers.sort.map { |a| require_index(a, q["choices"].length, where) }
        q.delete("answer")
      when "slider"
        q["min"] = js_num(q["min"].nil? ? 0 : q["min"])
        q["max"] = js_num(q["max"].nil? ? 100 : q["max"])
        raise InvalidQuestion, "#{where}: slider max must exceed min" unless q["min"] && q["max"] && q["max"] > q["min"]

        step = js_num(q["step"])
        q["step"] = step && step > 0 ? step : 1
        answer = js_num(q["answer"])
        raise InvalidQuestion, "#{where}: slider needs a numeric answer" if answer.nil? || (answer.is_a?(Float) && !answer.finite?)

        q["answer"] = answer
        # full marks within tolerance, sliding to zero at twice the tolerance
        tolerance = js_num(q["tolerance"])
        q["tolerance"] = tolerance && tolerance >= 0 ? tolerance : 0
        q["unit"] = q["unit"].is_a?(String) ? q["unit"] : ""
      when "text"
        source = q["accept"]
        source = q["answers"] if source.nil?
        source = q["answer"] if source.nil?
        accept = as_array(source).map { |s| js_str(s) }
        raise InvalidQuestion, "#{where}: text needs an accepted answer" if accept.empty?

        q["accept"] = accept
        q["fuzzy"] = q["fuzzy"] != false # forgive typos unless told not to
        q.delete("answer")
        q.delete("answers")
      when "wordcloud"
        max = js_num(q["maxWords"])
        q["maxWords"] = max && max > 0 ? [max, 5].min : 1
      when "order"
        items = as_array(q["items"]).map { |s| js_str(s) }
        raise InvalidQuestion, "#{where}: order needs 2-6 items" if items.length < 2 || items.length > 6

        q["items"] = items
      when "slide"
        nil
      end
      q
    end

    def require_choices(q, where)
      choices = q["choices"]
      raise InvalidQuestion, "#{where}: needs 2-4 choices" unless choices.is_a?(Array) && choices.length.between?(2, 4)

      q["choices"] = choices.map { |c| js_str(c) }
    end

    def require_index(v, len, where)
      index = as_index(v)
      raise InvalidQuestion, "#{where}: answer must be an index into choices" if index.nil? || index < 0 || index >= len

      index
    end

    # ---------- per-game presentation ----------

    # Anything randomised once per game, so every player sees the same thing.
    def presentation(q, random: Random)
      return nil unless q["type"] == "order"

      { "shown" => shuffled((0...q["items"].length).to_a, random: random) } # shown[position] = index into items
    end

    def shuffled(arr, random: Random)
      a = arr.dup
      (a.length - 1).downto(1) do |i|
        j = random.rand(i + 1)
        a[i], a[j] = a[j], a[i]
      end
      a
    end

    # What the host screen shows while the question is open.
    def host_view(q, pres)
      v = { "type" => q["type"], "text" => q["text"] }
      v["image"] = q["image"] unless q["image"].nil?
      v["time"] = q["time"]
      v["choices"] = q["choices"] if q["choices"]
      v.merge!(q.slice("min", "max", "step", "unit")) if q["type"] == "slider"
      v["items"] = pres["shown"].map { |i| q["items"][i] } if q["type"] == "order"
      v
    end

    # What a player's phone shows. Must never leak the answer.
    # With show_text the question and its choices are mirrored to the phone, so a
    # player who cannot read the projector still has everything they need.
    def player_view(q, pres, show_text: false)
      v = { "type" => q["type"], "time" => q["time"] }
      v["choices"] = q["choices"].length if q["choices"]
      # choice labels are safe to send: the host screen already shows them
      if %w[truefalse poll multi].include?(q["type"])
        v["labels"] = q["choices"]
      elsif show_text && q["choices"]
        v["labels"] = q["choices"]
      end
      if show_text
        v["text"] = q["text"]
        v["image"] = q["image"] if q["image"]
      end
      v.merge!(q.slice("min", "max", "step", "unit")) if q["type"] == "slider"
      v["maxWords"] = q["maxWords"] if q["type"] == "wordcloud"
      v["items"] = pres["shown"].map { |i| q["items"][i] } if q["type"] == "order"
      v
    end

    # ---------- answers ----------

    # Reject malformed responses before they reach grading. Returns the cleaned value.
    def parse_response(q, raw)
      case q["type"]
      when "choice", "truefalse", "poll"
        index = as_index(raw)
        raise BadResponse, "Invalid choice" if index.nil? || index < 0 || index >= q["choices"].length

        index
      when "multi"
        raise BadResponse, "Pick at least one answer" unless raw.is_a?(Array) && !raw.empty?

        set = raw.map { |x| as_index(x) || x }.uniq
        set.each do |i|
          raise BadResponse, "Invalid choice" unless i.is_a?(Integer) && i >= 0 && i < q["choices"].length
        end
        set.sort
      when "slider"
        n = js_num(raw)
        raise BadResponse, "Out of range" if n.nil? || (n.is_a?(Float) && !n.finite?) || n < q["min"] || n > q["max"]

        n
      when "text"
        s = js_str(raw.nil? ? "" : raw).strip[0, 80]
        raise BadResponse, "Type an answer" if s.empty?

        s
      when "wordcloud"
        words = as_array(raw).map { |w| js_str(w).strip[0, 30] }.reject(&:empty?).first(q["maxWords"].to_i)
        raise BadResponse, "Type at least one word" if words.empty?

        words
      when "order"
        n = q["items"].length
        raise BadResponse, "Order every item" unless raw.is_a?(Array) && raw.length == n

        order = raw.map { |x| as_index(x) || x }
        raise BadResponse, "Each item once" if order.uniq.length != n

        order.each do |i|
          raise BadResponse, "Invalid order" unless i.is_a?(Integer) && i >= 0 && i < n
        end
        order
      else
        raise BadResponse, "This question takes no answer"
      end
    end

    # Grade one response.
    # ratio is the fraction of full credit, so partial-credit types can award part marks.
    # correct is true only at full credit, and nil for types with no right answer.
    def grade(q, response, pres)
      return { "correct" => nil, "ratio" => 0 } if unscored?(q["type"])

      case q["type"]
      when "choice", "truefalse"
        binary(response == q["answer"])
      when "multi"
        want = q["answers"]
        hit = response.count { |i| want.include?(i) }
        miss = response.length - hit
        ratio = [0, (hit - miss).fdiv(want.length)].max
        { "correct" => ratio == 1, "ratio" => [ratio, 1].min }
      when "slider"
        tol = q["tolerance"]
        tol = (q["max"] - q["min"]) * 0.05 if tol.zero?
        off = (response - q["answer"]).abs
        return binary(true) if off <= tol

        ratio = [0, 1 - (off - tol).fdiv([tol, 1e-9].max)].max
        { "correct" => false, "ratio" => [ratio, 0.99].min }
      when "text"
        got = norm_text(response)
        q["accept"].each do |a|
          want = norm_text(a)
          next if want.empty?
          return binary(true) if got == want
          return binary(true) if q["fuzzy"] && levenshtein(got, want) <= fuzz_tolerance(want)
        end
        binary(false)
      when "order"
        # response[position] = index into the shown order; map back to original items
        n = q["items"].length
        right = (0...n).count { |pos| pres["shown"][response[pos]] == pos }
        { "correct" => right == n, "ratio" => right == n ? 1 : [0, (right - 1).fdiv(n)].max }
      else
        { "correct" => nil, "ratio" => 0 }
      end
    end

    def binary(ok)
      { "correct" => ok, "ratio" => ok ? 1 : 0 }
    end

    # The choice labels a report needs to name a wrong answer. Nil when there are none.
    def choice_labels(q)
      return q["choices"] if q["choices"]
      return q["items"] if q["type"] == "order"

      nil
    end

    # The correct answer, in a form the host screen can display.
    def answer_view(q, _pres)
      case q["type"]
      when "choice", "truefalse"
        { "index" => q["answer"], "label" => q["choices"][q["answer"]] }
      when "multi"
        { "indexes" => q["answers"], "label" => q["answers"].map { |i| q["choices"][i] }.join(", ") }
      when "slider"
        { "value" => q["answer"], "label" => "#{js_str(q["answer"])}#{q["unit"].empty? ? "" : " #{q["unit"]}"}" }
      when "text"
        { "accept" => q["accept"], "label" => q["accept"][0] }
      when "order"
        { "items" => q["items"], "label" => q["items"].join(" → ") }
      end
    end

    # How a player's own answer should read back to them, mirroring answer_view.
    # Order responses index into the shuffled list the player was shown, so they
    # have to be mapped back through the presentation to name the right items.
    def response_label(q, response, pres)
      return nil if response.nil?

      case q["type"]
      when "choice", "truefalse", "poll"
        q["choices"] && q["choices"][response]
      when "multi"
        response.empty? ? nil : response.map { |i| q["choices"][i] }.join(", ")
      when "slider"
        "#{js_str(response)}#{q["unit"].to_s.empty? ? "" : " #{q["unit"]}"}"
      when "text"
        js_str(response)
      when "order"
        response.map { |shown| q["items"][pres["shown"][shown]] }.join(" → ")
      when "wordcloud"
        response.is_a?(Array) ? response.join(", ") : js_str(response)
      end
    end

    # Aggregate every response for the host results screen.
    def summarize(q, pres, responses)
      case q["type"]
      when "choice", "truefalse", "poll"
        counts = Array.new(q["choices"].length, 0)
        responses.each { |r| counts[r] += 1 }
        { "kind" => "counts", "counts" => counts, "labels" => q["choices"] }
      when "multi"
        counts = Array.new(q["choices"].length, 0)
        responses.each { |r| r.each { |i| counts[i] += 1 } }
        { "kind" => "counts", "counts" => counts, "labels" => q["choices"] }
      when "slider"
        vals = responses.sort
        # summed left to right, as JavaScript does, so the mean matches the old reports exactly
        mean = vals.empty? ? nil : vals.inject(0) { |t, v| t + v }.fdiv(vals.length)
        { "kind" => "slider", "values" => vals, "mean" => mean, "min" => q["min"], "max" => q["max"], "unit" => q["unit"] }
      when "text", "wordcloud"
        freq = {}
        responses.each do |r|
          as_array(r).each do |w|
            k = norm_text(w)
            next if k.empty?

            cur = freq[k] ||= { "text" => js_str(w).strip, "n" => 0 }
            cur["n"] += 1
          end
        end
        words = freq.values.each_with_index.sort_by { |w, i| [-w["n"], i] }.map(&:first).first(40)
        { "kind" => "words", "words" => words }
      when "order"
        n = q["items"].length
        per_slot = Array.new(n, 0)
        responses.each do |r|
          (0...n).each { |pos| per_slot[pos] += 1 if pres["shown"][r[pos]] == pos }
        end
        { "kind" => "order", "perSlot" => per_slot, "items" => q["items"] }
      else
        { "kind" => "none" }
      end
    end
  end
end
