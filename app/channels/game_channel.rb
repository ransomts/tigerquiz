# The one websocket channel. A host or a player subscribes to their game with the
# token they were given over HTTP, then everything the game says arrives as a
# message with an "event" field, and host controls are actions on the channel.
class GameChannel < ApplicationCable::Channel
  def subscribed
    @conn_id = SecureRandom.hex(8)
    outcome = Games::Registry.with_room(params[:pin]) do |room|
      next :no_game unless room

      case params[:role]
      when "host"
        next :bad_token unless ActiveSupport::SecurityUtils.secure_compare(room.host_token, params[:token].to_s)

        @role = :host
        @pin = room.pin
        stream_from room.host_stream
        room.host_connected(@conn_id)
        :ok
      when "player"
        player = room.players[params[:name].to_s]
        next :bad_token unless player && ActiveSupport::SecurityUtils.secure_compare(player.token, params[:token].to_s)

        @role = :player
        @pin = room.pin
        @name = player.name
        stream_from room.players_stream
        stream_from room.player_stream(player.name)
        room.player_connected(player.name, @conn_id)
        :ok
      else
        :bad_role
      end
    end
    reject unless outcome == :ok
  end

  def unsubscribed
    return unless @role

    Games::Registry.with_room(@pin) do |room|
      next unless room

      @role == :host ? room.host_disconnected(@conn_id) : room.player_disconnected(@name, @conn_id)
    end
  end

  # ---------- host controls ----------
  def start(data) = host { |room| room.start(solo: data["solo"] == true) }
  def advance(_data) = host(&:advance)
  def prev(_data) = host(&:prev)
  def skip(_data) = host(&:skip)
  def revote(_data) = host(&:revote)
  def replay(_data) = host(&:restart_if_over)
  def pause(data) = host { |room| room.set_paused(data["paused"] != false) }
  def goto(data) = host { |room| room.jump(data["index"]) }
  def kick(data) = host { |room| room.kick(data["name"].to_s) }

  # ---------- players ----------
  def answer(data)
    result = { "ok" => false, "error" => "Not in a game" }
    if @role == :player
      Games::Registry.with_room(@pin) do |room|
        result = room ? room.record_answer(@name, data["response"]) : result
      end
    end
    transmit(result.merge("event" => "answer:ack", "seq" => data["seq"]))
  end

  private

  def host
    return unless @role == :host

    Games::Registry.with_room(@pin) { |room| yield room if room }
  end
end
