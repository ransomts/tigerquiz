# frozen_string_literal: true

require_relative "../tigerquiz"

module Tigerquiz
  # Nickname screening and suggestions.
  #
  # The goal is to stop what a class will actually try, not to be a comprehensive
  # filter. Two rules matter more than the word list itself:
  #   1. Disguises are collapsed first, so "sh1t" and "a$$" are caught.
  #   2. Innocent words that merely contain a blocked run are removed before
  #      matching, so "Cassidy", "classic" and "Scunthorpe" are not refused.
  # A word list can never be complete, so the host can still remove anyone from
  # the lobby with a click.
  module Nicknames
    BLOCKED = %w[
      anal anus arse ass bastard bitch boob bollock clit
      cock coon cum cunt dick dildo douche dyke fag
      fart fuck gash gook hitler homo jizz kike knob
      milf nazi nigg nonce paki penis piss poop porn
      prick pube pussy queef queer rape retard scrotum
      semen sex shit slut smegma spastic sperm spic
      tit turd twat vagina wank whore wetback
    ].freeze

    # Ordinary words and names that contain one of the runs above. Removed before
    # matching, longest first, so the innocent word absorbs its own letters.
    INNOCENT = %w[
      assassin assemble assembly assess asset assign assist
      associate assume assure bass brass cassidy class
      classic compass embassy glass grass harass lass mass
      massive pass passion passport potassium sassy vassal
      analog analy banal canal
      accumulate cucumber cumulative circumstance document scum
      cockatoo cockpit cockroach cocktail cockburn hancock
      hitchcock peacock shuttlecock woodcock
      scunthorpe penistone clitheroe lightwater
      essex middlesex sussex wessex sextant sexton sextet
      arsenal arsenic parse sparse coarse hoarse
      grape drape scrape therapist therapy
      titan titanic title competition petition constitute
      attitude gratitude altitude multitude practitioner
      buttress button butter shiitake dickens dickinson
      homogen homograph homonym homework shoe hoedown
      chestnut coconut doughnut nutmeg nutrition peanut walnut
      shitake
    ].each_with_index.sort_by { |w, i| [-w.length, i] }.map(&:first).freeze

    # Letters swapped for digits and symbols, so "sh1t" and "a$$" are caught too.
    LEET = {
      "0" => "o", "1" => "i", "3" => "e", "4" => "a", "5" => "s", "7" => "t", "8" => "b",
      "@" => "a", "$" => "s", "!" => "i", "|" => "l"
    }.freeze

    ADJECTIVES = %w[
      Brave Bright Calm Clever Cosmic Daring Eager Fearless
      Gentle Golden Happy Jolly Keen Lucky Mighty Noble
      Quick Quiet Rapid Sharp Silver Steady Sunny Swift
      Wandering Wise Zesty
    ].freeze
    NOUNS = %w[
      Otter Falcon Badger Comet Dolphin Ember Fox Gecko
      Heron Ibis Jaguar Kestrel Lynx Magpie Narwhal Osprey
      Panther Quokka Raven Seal Tiger Urchin Viper Walrus
      Yak Zebra
    ].freeze

    @extra = []

    class << self
      # Additional blocked words, loaded from a file with load_extra_words.
      attr_reader :extra

      # Load additional blocked words from a file, one per line. A missing file is fine.
      def load_extra_words(file)
        @extra = File.readlines(file, chomp: true)
                     .map { |l| l.strip.downcase.gsub(/[^a-z]/, "") }
                     .reject(&:empty?)
        @extra.length
      rescue SystemCallError
        @extra = []
        0
      end

      # Collapse the tricks people use to disguise a word: spacing, symbols, leetspeak.
      def flatten(name)
        name.to_s
            .downcase
            .unicode_normalize(:nfkd)
            .gsub(/[\u0300-\u036f]/, "") # combining accents
            .each_char.map { |c| LEET.fetch(c, c) }.join
            .gsub(/[^a-z]/, "")
      end

      # True when a nickname should be refused.
      def blocked?(name)
        flat = flatten(name)
        return false if flat.empty?

        # let ordinary words claim their own letters before anything is matched
        INNOCENT.each { |word| flat = flat.gsub(word, " ") }
        (BLOCKED + @extra).any? { |w| !w.empty? && flat.include?(w) }
      end

      # A friendly random nickname, short enough for the 20 character limit and
      # sure to pass the screen (SteadyKestrel does not).
      def suggest(random: Random)
        loop do
          name = "#{ADJECTIVES[random.rand(ADJECTIVES.length)]}#{NOUNS[random.rand(NOUNS.length)]}"[0, 20]
          return name unless blocked?(name)
        end
      end
    end
  end
end
