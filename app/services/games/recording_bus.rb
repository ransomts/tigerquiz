module Games
  # A bus that keeps every message, so tests can read what a room said.
  class RecordingBus
    attr_reader :messages

    def initialize
      @messages = []
    end

    def broadcast(stream, data)
      @messages << [stream, data]
    end

    # Every message sent on a stream, or only those with a given event, in order.
    def on(stream, event = nil)
      @messages.select { |s, d| s == stream && (event.nil? || d["event"] == event) }.map(&:last)
    end

    def clear = @messages.clear
  end
end
