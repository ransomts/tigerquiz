# frozen_string_literal: true

require_relative "plain_helper"

# Replays test/fixtures/parity.json, which records what the Node implementation
# did for a few thousand inputs, and checks the Ruby port gives the same answers.
# Regenerate the fixture from the Node tree with tools/parity-fixtures.mjs.
class ParityTest < Minitest::Test
  FIX = JSON.parse(File.read(File.join(FIXTURES, "parity.json")))
  Q = Tigerquiz::Questions

  # What the browser would receive: floats and integers collapse the way JSON does.
  def js(v) = JSON.parse(JSON.generate(v))

  # assert_equal refuses a nil expectation, and some views are legitimately nil
  def assert_json(expected, actual, msg)
    expected.nil? ? assert_nil(actual, msg) : assert_equal(expected, actual, msg)
  end

  # The fixture marks JavaScript's undefined, which JSON cannot carry, with a token.
  def undefined?(v) = v.is_a?(Hash) && v == { "undefined" => true }
  def unmark(v) = undefined?(v) ? nil : v

  def test_types
    assert_equal FIX["types"], Q::TYPES
  end

  def test_norm_text
    FIX["normText"].each do |c|
      assert_equal c["output"], Q.norm_text(unmark(c["input"])), "normText(#{c["input"].inspect})"
    end
  end

  def test_speed_points
    FIX["speedPoints"].each do |c|
      assert_equal c["points"], Q.speed_points(c["ms"], c["timeMs"]), "speedPoints(#{c["ms"]}, #{c["timeMs"]})"
    end
  end

  def test_normalize_question
    FIX["normalize"].each do |c|
      label = "normalize(#{c["input"].inspect})"
      if c["error"]
        e = assert_raises(Tigerquiz::InvalidQuestion, label) { Q.normalize_question(c["input"], c["i"]) }
        assert_equal c["error"], e.message, label
      else
        assert_equal c["output"], js(Q.normalize_question(c["input"], c["i"])), label
      end
    end
  end

  def valid_questions
    @valid_questions ||= FIX["normalize"].select { |c| c["output"] }.map { |c| Q.normalize_question(c["input"], c["i"]) }
  end

  def test_views_and_summaries
    FIX["responses"].each do |r|
      q = valid_questions[r["qi"]]
      pres = r["pres"]
      label = "#{q["type"]} question #{r["qi"]}"
      assert_equal r["hostView"], js(Q.host_view(q, pres)), "hostView #{label}"
      assert_equal r["playerView"], js(Q.player_view(q, pres)), "playerView #{label}"
      assert_equal r["playerViewText"], js(Q.player_view(q, pres, show_text: true)), "playerView showText #{label}"
      assert_json r["answerView"], js(Q.answer_view(q, pres)), "answerView #{label}"
      assert_json r["noAnswerLabel"], js(Q.response_label(q, nil, pres)), "responseLabel of no answer #{label}"
      assert_json r["choiceLabels"], js(Q.choice_labels(q)), "choiceLabels #{label}"
      assert_equal r["emptySummary"], js(Q.summarize(q, pres, [])), "empty summarize #{label}"
    end
  end

  def test_parse_grade_and_summarize
    FIX["responses"].each do |r|
      q = valid_questions[r["qi"]]
      pres = r["pres"]
      parsed = []
      r["cases"].each do |c|
        # Number(undefined) is NaN but Number(null) is 0, and only JavaScript can tell them apart
        next if undefined?(c["raw"]) && q["type"] == "slider"

        raw = unmark(c["raw"])
        label = "#{q["type"]} question #{r["qi"]} response #{raw.inspect}"
        if c["error"]
          e = assert_raises(Tigerquiz::BadResponse, label) { Q.parse_response(q, raw) }
          assert_equal c["error"], e.message, label
        else
          value = Q.parse_response(q, raw)
          assert_equal c["output"], js(value), "parse #{label}"
          assert_equal c["grade"], js(Q.grade(q, value, pres)), "grade #{label}"
          assert_json c["label"], js(Q.response_label(q, value, pres)), "responseLabel #{label}"
          parsed << value
        end
      end
      assert_equal r["summary"], js(Q.summarize(q, pres, parsed)), "summarize #{q["type"]} question #{r["qi"]}"
    end
  end

  def test_nicknames
    FIX["nicknames"].each do |c|
      assert_equal c["flat"], Tigerquiz::Nicknames.flatten(c["name"]), "flatten(#{c["name"].inspect})"
      assert_equal c["blocked"], Tigerquiz::Nicknames.blocked?(c["name"]), "blocked?(#{c["name"].inspect})"
    end
  end
end
