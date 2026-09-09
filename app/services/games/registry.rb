module Games
  # Every running game, and the one thread that fires their clocks.
  #
  # All game state lives here, in memory, in the single Puma process (see
  # PORT.md). Every way into a room, whether a channel action, an HTTP request
  # or a timer firing, goes through #synchronize, so a room is never touched by
  # two threads at once. The monitor is re-entrant, so rooms may call back in.
  class Registry
    class << self
      def instance
        @instance ||= new
      end

      delegate :create, :find, :with_room, :synchronize, :schedule, :cancel, :remove, :pins, :reset!, to: :instance
    end

    def initialize
      @monitor = Monitor.new
      @rooms = {}
      @timer_lock = Mutex.new
      @timer_cv = ConditionVariable.new
      @timers = {} # id => [due at (monotonic ms), block]
      @timer_seq = 0
      @thread = nil
    end

    def synchronize(&) = @monitor.synchronize(&)

    def create(quiz:, roster:, user:, bus: Bus.new, **room_options)
      synchronize do
        pin = make_pin
        @rooms[pin] = Room.new(pin: pin, quiz: quiz, roster: roster, user: user, bus: bus, registry: self, **room_options)
      end
    end

    def find(pin) = synchronize { @rooms[pin.to_s.strip] }

    # The room for a pin, under the lock. Yields nil when there is no such game.
    def with_room(pin)
      synchronize { yield @rooms[pin.to_s.strip] }
    end

    def remove(pin) = synchronize { @rooms.delete(pin) }
    def pins = synchronize { @rooms.keys }

    # Run the block after delay_ms, under the lock. Returns a handle for #cancel.
    def schedule(delay_ms, &block)
      id = nil
      @timer_lock.synchronize do
        id = (@timer_seq += 1)
        @timers[id] = [now_ms + delay_ms, block]
        @timer_cv.signal
      end
      ensure_timer_thread
      id
    end

    def cancel(id)
      @timer_lock.synchronize { @timers.delete(id) } if id
    end

    # Tests start from nothing.
    def reset!
      synchronize { @rooms.clear }
      @timer_lock.synchronize { @timers.clear }
    end

    private

    def make_pin
      loop do
        pin = format("%06d", SecureRandom.random_number(900_000) + 100_000)
        return pin unless @rooms.key?(pin)
      end
    end

    def now_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000).to_i

    def ensure_timer_thread
      return if @thread&.alive?

      @thread = Thread.new { run_timers }
      @thread.name = "tigerquiz-timers"
    end

    def run_timers
      loop do
        due = []
        @timer_lock.synchronize do
          next_at = @timers.values.map(&:first).min
          if next_at.nil?
            @timer_cv.wait(@timer_lock)
          elsif next_at > now_ms
            @timer_cv.wait(@timer_lock, (next_at - now_ms) / 1000.0)
          end
          now = now_ms
          @timers.each { |id, (at, blk)| due << [id, blk] if at <= now }
          due.each { |id, _| @timers.delete(id) }
        end
        due.each do |_, blk|
          synchronize { blk.call }
        rescue StandardError => e
          Rails.logger.error("game timer: #{e.class}: #{e.message}\n#{e.backtrace&.first(5)&.join("\n")}")
        end
      end
    end
  end
end
