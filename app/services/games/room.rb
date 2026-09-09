module Games
  # One live game: the players in it, the question on screen, the clock, and
  # everything the host can do. A port of the Room class in server.js.
  #
  # A room is only ever touched under Registry#synchronize. It talks to the
  # browsers through a Bus: every message carries an "event" name that the page
  # scripts switch on, and goes to one of three streams: the host's, every
  # player's, or one player's own.
  class Room
    STREAK_BONUS = 100 # per consecutive correct answer beyond the first
    STREAK_BONUS_CAP = 500
    STATES = %w[lobby question results end].freeze

    Player = Struct.new(:name, :token, :score, :connected, :streak, :identity, :prev_rank, :last, :conn, keyword_init: true)

    Q = Tigerquiz::Questions

    attr_reader :pin, :quiz, :roster, :user, :players, :state, :q_index, :answers, :pres, :host_token,
                :paused, :solo, :last_results, :last_end, :prior_vote, :game

    def initialize(pin:, quiz:, roster:, user:, bus:, registry:, host_grace_ms: Rails.application.config.tigerquiz.host_grace_ms)
      @pin = pin
      @quiz = quiz
      @roster = roster
      @user = user
      @bus = bus
      @registry = registry
      @host_grace_ms = host_grace_ms
      @players = {}
      @state = "lobby"
      @q_index = -1
      @answers = {} # name => { "response" =>, "ms" => }
      @pres = nil # per-question randomisation, shared by everyone
      @question_start = 0
      @timer = nil
      @timer_gen = 0
      @host_token = SecureRandom.hex(24)
      @host_conn = nil
      @host_grace = nil
      @paused = false
      @solo = false # a rehearsal with no players, which produces no report
      @paused_at = 0
      @paused_ms = 0 # total time spent paused during the current question
      @last_results = nil # replayed to a host that reconnects mid-results
      @last_end = nil
      @prior_vote = nil # first-round result, while a discussion re-vote is running
      @revoting = false
      # score and streak for every player as of the start of each question, so a
      # question can be replayed without double-counting what it already awarded
      @snapshots = {}
      @game = create_game_record
    end

    def user_id = @user.id
    def question = @quiz["questions"][@q_index]
    def total = @quiz["questions"].length
    def host_stream = "game:#{@pin}:host"
    def players_stream = "game:#{@pin}:players"
    def player_stream(name) = "game:#{@pin}:player:#{name}"

    # ---------- what the pages ask over HTTP ----------

    # What a host needs to take on the game, new or resumed.
    def describe
      {
        "pin" => @pin,
        "title" => @quiz["title"],
        "total" => total,
        "state" => @state,
        "paused" => @paused,
        "identifier" => @quiz["identifier"],
        "roster" => @roster ? { "title" => @roster["title"], "count" => @roster["students"].length } : nil,
        "questions" => @quiz["questions"].each_with_index.map { |q, i| { "index" => i, "type" => q["type"], "text" => q["text"] } }
      }
    end

    # What the join screen must ask for before a player can enter.
    def lobby_info
      {
        "title" => @quiz["title"],
        "identifier" => @roster ? "Your name or student ID" : @quiz["identifier"],
        "roster" => !@roster.nil?
      }
    end

    # A player joining, or rejoining after a dropped connection. Returns what the
    # phone needs, or an error to show.
    def join(name, identifier)
      name = name.to_s.strip[0, 20]
      identifier = identifier.to_s.strip[0, 40]
      return refuse("Enter a nickname") if name.empty?
      return refuse("Pick a different nickname") if Tigerquiz::Nicknames.blocked?(name)

      entry = nil
      if @roster
        entry = Tigerquiz::RosterDocument.match(@roster, identifier)
        return refuse("Not on the class list. Check your name or ID.") unless entry
      elsif @quiz["identifier"] && identifier.empty?
        return refuse("Enter your #{@quiz["identifier"]}")
      end
      identity = entry ? entry["name"] : identifier.presence

      p = @players[name]
      return refuse("That name is taken") if p&.connected
      if p.nil?
        return refuse("Game already started") unless @state == "lobby"

        p = Player.new(name: name, token: SecureRandom.hex(16), score: 0, connected: false, streak: 0, identity: identity)
        @players[name] = p
        @game.upsert_player(name, identity)
      else
        p.token = SecureRandom.hex(16) # the old connection is gone; this browser owns the name now
      end
      {
        "ok" => true,
        "name" => name,
        "token" => p.token,
        "state" => @state,
        "score" => p.score,
        "answered" => @answers.key?(name),
        "question" => @state == "question" ? question_head.merge(Q.player_view(question, @pres, show_text: @quiz["phoneText"])) : nil
      }
    end

    # ---------- connections ----------

    def player_connected(name, conn_id)
      p = @players[name] or return
      p.connected = true
      p.conn = conn_id
      emit(host_stream, "lobby:players", "players" => public_players)
      # put a returning phone back where the game is
      if @state == "question" && !@answers.key?(name)
        emit_question(target: name)
      elsif @state == "end" && @last_end
        emit_player_end(p, @last_end["leaderboard"])
      end
    end

    def player_disconnected(name, conn_id)
      p = @players[name]
      return unless p && p.conn == conn_id

      p.connected = false
      p.conn = nil
      @players.delete(name) if @state == "lobby"
      emit(host_stream, "lobby:players", "players" => public_players)
    end

    def host_connected(conn_id)
      @host_conn = conn_id
      if @host_grace
        @registry.cancel(@host_grace)
        @host_grace = nil
        emit(players_stream, "game:hostaway", "away" => false)
      end
      emit(host_stream, "lobby:players", "players" => public_players)
      # put the screen back where the game is
      case @state
      when "question" then emit_question(target: :host)
      when "results" then emit(host_stream, "game:results", @last_results) if @last_results
      when "end" then emit(host_stream, "game:end", @last_end) if @last_end
      end
    end

    def host_disconnected(conn_id)
      return unless conn_id == @host_conn

      @host_conn = nil
      host_dropped
    end

    # ---------- host controls ----------

    def start(solo: false)
      return unless @state == "lobby"
      # rehearsing alone is allowed, so a quiz can be checked before a lesson
      return emit(host_stream, "game:error", "message" => "No players have joined yet") if @players.empty? && !solo

      @solo = solo && @players.empty?
      start_question
    end

    def advance
      # slides are advanced straight past, without a results step
      return start_question if @state == "question" && !Q.answerable?(question["type"])
      return unless @state == "results"

      start_question
    end

    def prev
      return if @state == "lobby" || @state == "end"

      # from a results screen, "back" means replay the question just shown
      target = @state == "results" ? @q_index : @q_index - 1
      go_to(target) if target >= 0
    end

    def jump(index)
      return if @state == "lobby" || @state == "end"

      index = Q.as_index(index) or return
      go_to(index)
    end

    def skip
      return start_question if @state == "question" && !Q.answerable?(question["type"])

      end_question("host")
    end

    # Peer instruction: keep the first vote, ask the same question again, then
    # show both distributions side by side.
    def revote
      return unless @state == "results" && @last_results

      @prior_vote = @last_results["summary"]
      @revoting = true
      go_to(@q_index)
    end

    def restart_if_over
      restart if @state == "end"
    end

    def kick(name)
      p = @players.delete(name) or return

      emit(player_stream(p.name), "game:kicked")
      emit(host_stream, "lobby:players", "players" => public_players)
    end

    def set_paused(paused)
      return if @state != "question" || @paused == paused
      return unless question["time"] > 0 # slides have no clock to stop

      @paused = paused
      if paused
        @paused_at = now_ms
        cancel_timer
      else
        @paused_ms += now_ms - @paused_at
        @paused_at = 0
        arm_timer
      end
      payload = { "paused" => paused, "endsAt" => ends_at, "remainingMs" => remaining_ms }
      emit(host_stream, "game:paused", payload)
      emit(players_stream, "game:paused", payload)
    end

    # ---------- the clock ----------

    # Milliseconds left on the clock, ignoring time spent paused.
    def remaining_ms
      q = question
      return 0 if !q || q["time"] <= 0

      elapsed = (@paused ? @paused_at : now_ms) - @question_start - @paused_ms
      [(q["time"] * 1000).round - elapsed, 0].max
    end

    def ends_at
      q = question
      return nil if !q || q["time"] <= 0 || @paused

      now_ms + remaining_ms
    end

    # ---------- play ----------

    def public_players
      @players.values.map { |p| { "name" => p.name, "score" => p.score, "connected" => p.connected } }
    end

    # Standard competition ranking: equal scores share a rank and the next one
    # skips, so three players tied on top are all 1st and the next is 4th.
    # Ranking by position instead would have handed out 1st, 2nd and 3rd in the
    # order people happened to join the lobby, since the players hash keeps
    # insertion order and the sort below is stable.
    def leaderboard
      rank = 0
      prev = nil
      public_players.each_with_index.sort_by { |p, i| [-p["score"], i] }.map(&:first)
                    .each_with_index.map do |p, i|
        if p["score"] != prev
          rank = i + 1
          prev = p["score"]
        end
        p.merge("rank" => rank)
      end
    end

    def start_question(index = @q_index + 1)
      return finish if index >= total

      go_to(index)
    end

    # Open question `index`, forwards or backwards. Going back rewinds every score
    # and streak to what they were before that question, and forgets the answers
    # recorded from it onward, so replaying cannot award the same points twice.
    def go_to(index)
      index = index.clamp(0, total - 1)
      if (snap = @snapshots[index])
        snap.each do |name, was|
          p = @players[name] or next
          p.score = was[:score]
          p.streak = was[:streak]
          p.prev_rank = was[:prev_rank]
        end
        @game.forget_from(index)
      end
      # anything at or beyond this point is being replayed, so its snapshot is stale
      @snapshots.delete_if { |i, _| i > index }
      @snapshots[index] = @players.values.to_h { |p| [p.name, { score: p.score, streak: p.streak || 0, prev_rank: p.prev_rank }] }

      @prior_vote = nil unless @revoting
      @revoting = false
      @q_index = index
      @state = "question"
      @answers.clear
      @last_results = nil
      @pres = Q.presentation(question)
      @question_start = now_ms
      @paused = false
      @paused_at = 0
      @paused_ms = 0
      emit_question
      arm_timer
    end

    def record_answer(name, response)
      return refuse("No question open") unless @state == "question"
      return refuse("The host paused the game") if @paused

      q = question
      return refuse("Nothing to answer here") unless Q.answerable?(q["type"])
      return refuse("Already answered") if @answers.key?(name)

      value = begin
        Q.parse_response(q, response)
      rescue Tigerquiz::BadResponse => e
        return refuse(e.message)
      end
      # time spent paused does not count against the player
      @answers[name] = { "response" => value, "ms" => now_ms - @question_start - @paused_ms }
      emit(host_stream, "game:answered", "answered" => @answers.size, "players" => @players.size)
      connected = @players.values.count(&:connected)
      end_question("everyone") if @answers.size >= connected
      { "ok" => true }
    end

    # "time" the clock ran out, "host" the host moved on, "everyone" all answered
    def end_question(ended_by = "time")
      return unless @state == "question"

      cancel_timer
      @paused = false
      @state = "results"
      q = question
      time_ms = (q["time"] * 1000).round
      unscored = Q.unscored?(q["type"])
      rows = []

      @players.each_value do |p|
        a = @answers[p.name]
        gained = 0
        bonus = 0
        result = { "correct" => nil, "ratio" => 0 }
        if a
          result = Q.grade(q, a["response"], @pres)
          gained = (Q.speed_points(a["ms"], time_ms) * result["ratio"]).round if result["ratio"] > 0
        end
        unless unscored
          if result["correct"] == true
            p.streak = (p.streak || 0) + 1
            bonus = [(p.streak - 1) * STREAK_BONUS, STREAK_BONUS_CAP].min
          else
            p.streak = 0
          end
        end
        p.score += gained + bonus
        p.last = { gained: gained, bonus: bonus, correct: result["correct"], ratio: result["ratio"], response: a && a["response"] }
        if a || !unscored
          rows << { "player" => p.name, "response" => a && a["response"], "ms" => a && a["ms"], "correct" => result["correct"], "points" => gained + bonus }
        end
      end

      answer_view = Q.answer_view(q, @pres)
      @game.record_question(@q_index, {
        "type" => q["type"], "text" => q["text"], "answerLabel" => answer_view && answer_view["label"],
        "choices" => Q.choice_labels(q), "explanation" => q["explanation"], "sourceIndex" => q["sourceIndex"],
        "correctAnswer" => q["type"] == "multi" ? q["answers"] : q["answer"]
      })
      @game.record_answers(@q_index, rows)

      responses = @answers.values.map { |a| a["response"] }
      board = leaderboard
      board.each { |b| @players[b["name"]].prev_rank ||= b["rank"] }

      summary = Q.summarize(q, @pres, responses)
      @last_results = {
        "index" => @q_index,
        "text" => q["text"],
        "type" => q["type"],
        "image" => q["image"],
        "answer" => answer_view,
        "explanation" => q["explanation"],
        # a re-vote is worth offering whenever opinion was split, and the quiz can ask for it
        "suggestDiscussion" => q["discuss"] || split_vote?(summary, answer_view),
        "summary" => summary,
        "priorSummary" => @prior_vote,
        "answered" => responses.length,
        "players" => @players.size,
        "leaderboard" => board.first(5),
        "isLast" => @q_index == total - 1
      }
      @prior_vote = nil
      emit(host_stream, "game:results", @last_results)

      @players.each_value do |p|
        idx = board.index { |b| b["name"] == p.name }
        # the nearest player actually ahead, not merely listed above: anyone on
        # the same score is level, and "0 points behind" is not a gap to close
        a = idx - 1
        a -= 1 while a >= 0 && board[a]["score"] == p.score
        ahead = a >= 0 ? board[a] : nil
        level = board.select { |b| b["score"] == p.score && b["name"] != p.name }
        emit(player_stream(p.name), "game:results", {
          "type" => q["type"],
          "unscored" => unscored,
          "correct" => p.last[:correct],
          "ratio" => p.last[:ratio],
          "gained" => p.last[:gained],
          "bonus" => p.last[:bonus],
          "streak" => p.streak || 0,
          "score" => p.score,
          "rank" => board[idx]["rank"],
          "prevRank" => p.prev_rank || board[idx]["rank"],
          "ahead" => ahead ? { "name" => ahead["name"], "gap" => ahead["score"] - p.score } : nil,
          "answer" => answer_view,
          # read the player's own answer back to them: without it the phone shows
          # the right answer with no reminder of what they actually picked, and
          # quizzes with phoneText off never showed them the question either
          "yourAnswer" => Q.response_label(q, p.last[:response], @pres),
          "explanation" => q["explanation"],
          "answered" => !p.last[:response].nil?,
          # being level with someone is worth knowing, and the gap above cannot
          # say so any more now that it skips players on the same score
          "levelWith" => level.map { |b| b["name"] },
          "endedBy" => ended_by
        })
        p.prev_rank = board[idx]["rank"]
      end
    end

    # Play the same quiz again with whoever is still here, scores back to zero.
    def restart
      cancel_timer
      @state = "lobby"
      @q_index = -1
      @answers.clear
      @snapshots.clear
      @last_results = nil
      @last_end = nil
      @prior_vote = nil
      @paused = false
      @players.each_value do |p|
        p.score = 0
        p.streak = 0
        p.prev_rank = nil
        p.last = nil
      end
      # a fresh game record, so the two runs are reported separately
      @game = create_game_record
      @players.each_value { |p| @game.upsert_player(p.name, p.identity) }
      emit(host_stream, "game:restarted", "players" => public_players)
      emit(players_stream, "game:restarted")
      emit(host_stream, "lobby:players", "players" => public_players)
    end

    def finish
      @state = "end"
      @paused = false
      cancel_timer
      board = leaderboard
      if @solo
        # a rehearsal with no players is not worth a report
        @game.discard_if_unfinished
        @last_end = { "leaderboard" => board, "reportId" => nil, "solo" => true }
        return emit(host_stream, "game:end", @last_end)
      end
      @game.finish!(board, total)
      @last_end = { "leaderboard" => board, "reportId" => @game.id }
      emit(host_stream, "game:end", @last_end)
      @players.each_value { |p| emit_player_end(p, board) }
    end

    # The host's browser dropped. Pause and hold the room open for a grace period
    # so a sleeping laptop or a wifi blip does not destroy the game and its report.
    def host_dropped
      @registry.cancel(@host_grace)
      set_paused(true)
      emit(players_stream, "game:hostaway", "away" => true)
      gen = (@timer_gen += 1)
      @host_grace = @registry.schedule(@host_grace_ms) { destroy if @host_grace && @timer_gen == gen }
    end

    def destroy
      cancel_timer
      @registry.cancel(@host_grace)
      @host_grace = nil
      # a game the host abandoned mid-way is not worth keeping a report for
      @game.discard_if_unfinished if @state != "end"
      emit(players_stream, "game:closed")
      @registry.remove(@pin)
    end

    private

    def create_game_record
      @user.games.create!(
        quiz: @user.quizzes.find_by(slug: @quiz["id"]),
        roster: @roster && @user.rosters.find_by(slug: @roster["id"]),
        pin: @pin, quiz_slug: @quiz["id"], title: @quiz["title"], started_at: Time.current
      )
    end

    def refuse(message) = { "ok" => false, "error" => message }

    def now_ms = (Process.clock_gettime(Process::CLOCK_REALTIME) * 1000).to_i

    def emit(stream, event, payload = {})
      @bus.broadcast(stream, payload.merge("event" => event))
    end

    def question_head
      q = question
      {
        "index" => @q_index,
        "total" => total,
        "endsAt" => ends_at,
        "totalMs" => (q["time"] * 1000).round,
        "remainingMs" => remaining_ms,
        "paused" => @paused,
        "revote" => !@prior_vote.nil?
      }
    end

    # Send the current question to everyone, or to one screen on reconnect.
    def emit_question(target: nil)
      q = question
      head = question_head
      for_host = head.merge(Q.host_view(q, @pres))
      for_player = head.merge(Q.player_view(q, @pres, show_text: @quiz["phoneText"]))
      case target
      when :host then emit(host_stream, "game:question", for_host)
      when String then emit(player_stream(target), "game:question", for_player)
      else
        emit(host_stream, "game:question", for_host)
        emit(players_stream, "game:question", for_player)
      end
    end

    def emit_player_end(p, board)
      rank = board.find { |b| b["name"] == p.name }&.dig("rank") || 0
      emit(player_stream(p.name), "game:end", "score" => p.score, "rank" => rank, "players" => board.length)
    end

    # Restart the question timer for whatever is left on the clock.
    def arm_timer
      cancel_timer
      q = question
      return if !q || q["time"] <= 0 || @paused || @state != "question"

      gen = @timer_gen
      @timer = @registry.schedule(remaining_ms + 250) { end_question("time") if @timer_gen == gen }
    end

    def cancel_timer
      @registry.cancel(@timer)
      @timer = nil
      @timer_gen += 1
    end

    # Peer instruction pays off when opinion is divided. Suggest a re-vote when the
    # class is split, meaning between a third and four fifths got it right.
    def split_vote?(summary, answer_view)
      return false if answer_view.nil? || summary["kind"] != "counts" || summary["counts"].nil?

      total = summary["counts"].sum
      return false if total < 3

      right = answer_view["indexes"] || [answer_view["index"]]
      got = right.sum { |i| summary["counts"][i] || 0 }
      rate = got.fdiv(total)
      rate >= 0.3 && rate <= 0.8
    end
  end
end
