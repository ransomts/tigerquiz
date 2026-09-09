module Games
  # Where a room's messages go: Action Cable. Tests swap in a RecordingBus.
  class Bus
    def broadcast(stream, data)
      ActionCable.server.broadcast(stream, data)
    end
  end
end
