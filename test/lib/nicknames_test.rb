# frozen_string_literal: true

require_relative "plain_helper"

class NicknamesTest < Minitest::Test
  N = Tigerquiz::Nicknames

  def teardown
    N.load_extra_words("/nonexistent") # back to the built-in list
  end

  def test_suggestions_fit_the_name_limit
    100.times do
      name = N.suggest
      assert_match(/\A[A-Z][a-z]+[A-Z][a-z]+\z/, name)
      assert_operator name.length, :<=, 20
      refute N.blocked?(name)
    end
    assert_equal N.suggest(random: Random.new(1)), N.suggest(random: Random.new(1))
  end

  def test_extra_words_come_from_a_file
    Dir.mktmpdir do |dir|
      file = File.join(dir, "blocked-words.txt")
      File.write(file, "Blorp\n\n  zonk!  \n")
      assert_equal 2, N.load_extra_words(file)
      assert_equal %w[blorp zonk], N.extra
      assert N.blocked?("Bl0rp")
      assert N.blocked?("zonkmaster")
      refute N.blocked?("Tim")
    end
  end

  def test_missing_extra_file_is_fine
    assert_equal 0, N.load_extra_words("/nonexistent/words.txt")
    assert_equal [], N.extra
  end

  def test_innocent_words_are_sorted_longest_first
    lengths = N::INNOCENT.map(&:length)
    assert_equal lengths.sort.reverse, lengths
  end
end
